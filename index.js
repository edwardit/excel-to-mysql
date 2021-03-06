
"use strict";

var readExcel = require('read-excel-file/node');
var fs = require('fs');
var mysql = require('mysql');
var mysqldump = require('mysqldump');
const csv=require('csvtojson');
var path = require('path');

//Differentiate between float and integer value
var isInt = function(n){
	return parseInt(n) === n
};
//Format date according to mysql format
function formatDate(date) {
	var d = new Date(date),
	month = '' + (d.getMonth() + 1),
	day = '' + d.getDate(),
	year = d.getFullYear();
	if (month.length < 2) month = '0' + month;
	if (day.length < 2) day = '0' + day;
	return [year, month, day].join('-');
}
//check the number of digits
function numDigits(x) {
	return (Math.log10((x ^ (x >> 31)) - (x >> 31)) | 0) + 1;
}
var noOfOperations = 0;

//return int/bigint
function returnString(s, n){
	++noOfOperations;
	if(noOfOperations == s){
		if(checkInt){
			if(numDigits(n)<8){
				return "int,";
			}
			else{
				return "bigint,";
			}
		}
	}
	return "";
}
//check if object is date (Excel format)
function isDate(d){
	return d instanceof Date && !isNaN(d);
}
var checkInt = true;

//Function to convert to file
exports.convertToFile = function(data, options, callback){
	//optional parameter 'options'
	if(typeof options === 'function'){
		callback = options;
		options = {};
	}
	noOfOperations = 0;
	return new Promise((resolve, reject) => {
		var sRow = 0;
		var eRow = 0;
		var sCol = 0;
		var eCol = 0;
		//Get the extension of the input file
		var d = (data.path).toString().slice(data.path.toString().length-3, data.path.toString().length);
		if(d == 'csv' || d == 'CSV'){
			//if csv then input the file and output as rows as array of objects
			fs.readFile(data.path, 'utf8', function(error, sdata){
				csv({
				    noheader:true,
				    output: "csv"
				})
				.fromString(sdata)
				.then((rows)=>{
					var progress = 1;
					var tableString = '';
					if(options.customStartEnd === true){
						//No need to parse the all the rows
						if(options.startRow && options.startCol && options.endRow && options.endCol){
							sRow = options.startRow-1;
							eRow = options.endRow;
							sCol = options.startCol-1;
							eCol = options.endCol;
						}
						else{
							reject("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
							return callback("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
						}
					}
					else{
						eCol = rows[0].length;
						eRow = rows.length;
					}
					//Make the string to insert as a query in MySQL
					if(options.autoId){
						tableString+='id int,';
					}
					//Scan the second row to check for the datatypes.
					//In case of numbers, we scan the whole column to make sure the datatype is int or float.
					for(var i=sCol;i<eCol;i++){
						noOfOperations = 0;
						checkInt = true;
						rows[sRow][i] = rows[sRow][i].toString().split(" ").join("_");
						tableString+=rows[sRow][i]+" ";
						//Check if the input is a number
						if(typeof(rows[sRow+1][i]) === 'number'){
							for(var j=sRow+1;j<eRow;j++){
								if(!isInt(rows[j][i])){
									//Check if it is float
									tableString+="float,";
									checkInt = false;
									break;
								}
								tableString+=returnString(eRow-1, rows[sRow+1][i]);
							}
						}
						//If the data is a string
						else if(typeof(rows[sRow+1][i]) === 'string'){
							tableString+="text,";
						}
						//MS Excel date is object in javascript.
						else if(typeof(rows[sRow+1][i]) === 'object'){
							if(isDate(rows[sRow+1][i])){
								tableString+="date,";
								for(var j=sRow+1;j<eRow;j++){
									rows[j][i] = formatDate(rows[j][i]);
								}
							}
							else{
								//In case of unsupported datatype
								reject("Datatype unsupported!");
								return callback("Datatype unsupported!");
							}
						}
						//0 or 1 also corresponds to bool
						else if(typeof(rows[sRow+1][i])==='boolean'){
							tableString+="bool,";
						}
					}
					tableString = tableString.replace(/.$/,"");
					if(!data.table){
						reject("Please specify a table");
						return callback("Please specify a table");
					}
					if(!data.db){
						reject("Please specify a database");
						return callback("Please specify a database");
					}
					//Fire up the query
					fs.writeFile('./'+data.db+'.sql', 'create database if not exists '+data.db+';\nuse '+data.db+';\ncreate table if not exists '+data.table+' ('+tableString+');\n', function(error){
						if(error) throw error;
						else{
							//Create the string first and then insert the full data at once.
							//The db operations are a bit slow in comparison to js.
							var insertString = '';
							for(var i=sRow+1;i<eRow;i++){
								insertString+='(';
								if(options.autoId){
									insertString+=i+",";
								}
								for(var j=sCol;j<eCol;j++){
									if(!rows[i]){
										reject('End points may be defined out of bounds in reference to the file.');
										return callback('End points may be defined out of bounds in reference to the file.');
									}
									if(rows[i][j] === true){
										insertString+="1,"
									}
									else if(rows[i][j] === false){
										insertString+="0,"
									}
									else{
										insertString+="\""+rows[i][j]+"\",";
									}
								}
								//Remove the trailing commas and spaces
								insertString = insertString.replace(/.$/,"");
								insertString+='),';
							}
							//Remove the trailing comma.
							insertString = insertString.replace(/.$/,'');
							//Acquires lock on the table to allow concurrent operations.
							//This is done to avoid the irregular insertion in the database.
							fs.appendFile('./'+data.db+'.sql', 'Lock tables '+data.table+' write;\n', function(error){
								if(error) throw error;
								else{
									fs.appendFile('./'+data.db+'.sql', 'insert into '+data.table+' values'+insertString+';\n', function(error){
										if(error) throw error;
										else{
											//Unlock the tables
											fs.appendFile('./'+data.db+'.sql', 'unlock tables;\n', function(error){
												if(error) throw error;
												else{
													resolve('DONE');
													return callback(null, 'DONE');
												}
											});
										}
									});
								}
							});
						}
					});
				});
			});
		}
		else{
			//If the file is not a csv format but regular excel format (xls/xlsx)
			readExcel(fs.createReadStream(data.path)).then((rows) => {
				var progress = 1;
				var tableString = '';
				if(options.customStartEnd === true){
					//No need to parse the all the rows
					if(options.startRow && options.startCol && options.endRow && options.endCol){
						sRow = options.startRow-1;
						eRow = options.endRow;
						sCol = options.startCol-1;
						eCol = options.endCol;
					}
					else{
						reject("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
						return callback("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
					}
				}
				else{
					eCol = rows[0].length;
					eRow = rows.length;
				}
				//Make the string to insert as a query in MySQL
				if(options.autoId){
					tableString+='id int,';
				}
				//Scan the second row to check for the datatypes.
				//In case of numbers, we scan the whole column to make sure the datatype is int or float.
				for(var i=sCol;i<eCol;i++){
					noOfOperations = 0;
					checkInt = true;
					rows[sRow][i] = rows[sRow][i].toString().split(" ").join("_");
					tableString+=rows[sRow][i]+" ";
					//Check if the input is a number
					if(typeof(rows[sRow+1][i]) === 'number'){
						for(var j=sRow+1;j<eRow;j++){
							if(!isInt(rows[j][i])){
								//Check if it is float
								tableString+="float,";
								checkInt = false;
								break;
							}
							tableString+=returnString(eRow-1, rows[sRow+1][i]);
						}
					}
					//If the data is a string
					else if(typeof(rows[sRow+1][i]) === 'string'){
						tableString+="text,";
					}
					//MS Excel date is object in javascript.
					else if(typeof(rows[sRow+1][i]) === 'object'){
						if(isDate(rows[sRow+1][i])){
							tableString+="date,";
							for(var j=sRow+1;j<eRow;j++){
								rows[j][i] = formatDate(rows[j][i]);
							}
						}
						else{
							//In case of unsupported datatype
							reject("Datatype unsupported!");
							return callback("Datatype unsupported!");
						}
					}
					//0 or 1 also corresponds to bool
					else if(typeof(rows[sRow+1][i])==='boolean'){
						tableString+="bool,";
					}
				}
				tableString = tableString.replace(/.$/,"");
				if(!data.table){
					reject("Please specify a table");
					return callback("Please specify a table");
				}
				if(!data.db){
					reject("Please specify a database");
					return callback("Please specify a database");
				}
				//Fire up the query
				fs.writeFile('./' + data.db + '.sql', 'create database if not exists ' + data.db +';\nuse '+data.db+';\ncreate table if not exists '+data.table+' ('+tableString+');\n', function(error){
					if(error) throw error;
					else{
						//Create the string first and then insert the full data at once.
						//The db operations are a bit slow in comparison to js.
						var insertString = '';
						for(var i=sRow+1;i<eRow;i++){
							insertString+='(';
							if(options.autoId){
								insertString+=i+",";
							}
							for(var j=sCol;j<eCol;j++){
								if(!rows[i]){
									reject('End points may be defined out of bounds in reference to the file.');
									return callback('End points may be defined out of bounds in reference to the file.');
								}
								if(rows[i][j] === true){
									insertString+="1,"
								}
								else if(rows[i][j] === false){
									insertString+="0,"
								}
								else{
									insertString+="\""+rows[i][j]+"\",";
								}
							}
							//Remove the trailing commas and spaces
							insertString = insertString.replace(/.$/,"");
							insertString+='),';
						}
						insertString = insertString.replace(/.$/,'');
						//Acquires lock on the table to allow concurrent operations.
						//This is done to avoid the irregular insertion in the database.
						fs.appendFile('./'+data.db+'.sql', 'Lock tables '+data.table+' write;\n', function(error){
							if(error) throw error;
							else{
								fs.appendFile('./'+data.db+'.sql', 'insert into '+data.table+' values'+insertString+';\n', function(error){
									if(error) throw error;
									else{
										//Unlock the tables
										fs.appendFile('./'+data.db+'.sql', 'unlock tables;\n', function(error){
											if(error) throw error;
											else{
												resolve('DONE');
												return callback(null, 'DONE');
											}
										});
									}
								});
							}
						});
					}
				});		
			});
		}
	});
}
//Function to send the data directly to the database.
exports.covertToMYSQL = function(data, options, callback){
	//optional parameter 'options'
	if(typeof options === 'function'){
		callback = options;
		options = {};
	}
	if(options.verbose !=false){
		options.verbose = true;
	}
	noOfOperations = 0;
	return new Promise((resolve, reject) => {
		var sRow = 0;
		var eRow = 0;
		var sCol = 0;
		var eCol = 0;
		//Get the extension of the input file
		if(options.safeMode){
			if(options.verbose){
				console.log('Backing up database');
			}
			//Dump the database in case safe mode is set
			mysqldump({
				connection: {
					host: data.host,
					user: data.user,
					password: data.pass,
					database: data.db,
				},
				dumpToFile: path.join(process.cwd(), data.db+'.sql'),
			});
		}
		//Try to connect with the provided credentials
		var connection = mysql.createConnection({
			host: data.host,
			user: data.user,
			password: data.pass,
			multipleStatements: true
		});
		//multipleStatements allow queries to be multiple in a single call.
		connection.connect(function(error){
			if(options.verbose){
				console.log('Establishing connection!');
			}
			if(error){
				if(error.code == 'ER_ACCESS_DENIED_ERROR'){
					reject("Authentication Error!");
					return callback("Authentication Error!");
				}
				else{
					reject(error);
					return callback(error);
				}
			}
			else{
				var d = (data.path).toString().slice(data.path.toString().length-3, data.path.toString().length);
				if(d == 'csv' || d == 'CSV'){
					//if csv then input the file and output as rows as array of objects
					fs.readFile(data.path, 'utf8', function(error, sdata){
						csv({
						    noheader:true,
						    output: "csv"
						})
						.fromString(sdata)
						.then((rows)=>{ 
							var progress = 1;
							var tableString = '';
							if(options.customStartEnd === true){
								//No need to parse the all the rows
								if(options.startRow && options.startCol && options.endRow && options.endCol){
									sRow = options.startRow-1;
									eRow = options.endRow;
									sCol = options.startCol-1;
									eCol = options.endCol;
								}
								else{
									reject("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
									return callback("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
								}
							}
							else{
								eCol = rows[0].length;
								eRow = rows.length;
							}
							//Make the string to insert as a query in MySQL
							if(options.autoId){
								tableString+='id int,';
							}
							//Scan the second row to check for the datatypes.
							//In case of numbers, we scan the whole column to make sure the datatype is int or float.
							for(var i=sCol;i<eCol;i++){
								noOfOperations = 0;
								checkInt = true;
								rows[sRow][i] = rows[sRow][i].toString().split(" ").join("_");
								tableString+=rows[sRow][i]+" ";
								//Check if the input is a number
								if(typeof(rows[sRow+1][i]) === 'number'){
									for(var j=sRow+1;j<eRow;j++){
										if(!isInt(rows[j][i])){
											//Check if it is float
											tableString+="float,";
											checkInt = false;
											break;
										}
										tableString+=returnString(eRow-1, rows[sRow+1][i]);
									}
								}
								//If the data is a string
								else if(typeof(rows[sRow+1][i]) === 'string'){
									tableString+="text,";
								}
								//MS Excel date is object in javascript.
								else if(typeof(rows[sRow+1][i]) === 'object'){
									if(isDate(rows[sRow+1][i])){
										tableString+="date,";
										for(var j=sRow+1;j<eRow;j++){
											rows[j][i] = formatDate(rows[j][i]);
										}
									}
									else{
										//In case of unsupported datatype
										reject("Datatype unsupported!");
										return callback("Datatype unsupported!");
									}
								}
								//0 or 1 also corresponds to bool
								else if(typeof(rows[sRow+1][i])==='boolean'){
									tableString+="bool,";
								}
							}
							tableString = tableString.replace(/.$/,"");
							//Fire up the query
							//Create database if not exists to allow database creation directly.
							connection.query('create database if not exists '+data.db+';use '+data.db+';create table if not exists '+data.table+' ('+tableString+')', function(error, results){
								if(options.verbose){
									console.log('Table created!');
								}
								if(error){
									console.log(error);
									if(error.code=='ER_PARSE_ERROR'){
										reject('It seems that the column heading are not in text format.');
										return callback('It seems that the column heading are not in text format.');
									}
									else{
										reject(error);
										return callback(error);
									}
								}
								else{
									//Create the string first and then insert the full data at once.
									//The db operations are a bit slow in comparison to js.
									var insertString = '';
									for(var i=sRow+1;i<eRow;i++){
										insertString+='(';
										if(options.autoId){
											insertString+=i+",";
										}
										for(var j=sCol;j<eCol;j++){
											if(!rows[i]){
												reject('End points may be defined out of bounds in reference to the file.');
												return callback('End points may be defined out of bounds in reference to the file.');
											}
											if(rows[i][j] === true){
												insertString+="1,"
											}
											else if(rows[i][j] === false){
												insertString+="0,"
											}
											else{
												insertString+="\""+rows[i][j]+"\",";
											}
										}
										//Remove the trailing commas and spaces
										insertString = insertString.replace(/.$/,"");
										insertString+='),';
									}
									//Remove the trailing comma.
									insertString = insertString.replace(/.$/,'');
									//Acquires lock on the table to allow concurrent operations.
									//This is done to avoid the irregular insertion in the database.
									connection.query('Lock tables '+data.table+' write', function(error, results){
										if(error) throw error;
										else{
											connection.query('insert into '+data.table+' values'+insertString, function(error, results){
												if(options.verbose){
													console.log('Inserting data!');
												}
												if(error){
													//Unlock the tables
													connection.query('unlock tables', function(error, results){
														if(error) throw error;
														else{
															connection.end();
														}
													});
													if(error.code == 'ER_WRONG_VALUE_COUNT_ON_ROW'){
														reject('The table you provided either already contains some data or there is a problem with the already prevailing column count.');
														return callback('The table you provided either already contains some data or there is a problem with the already prevailing column count.');
													}
													else{
														reject("Incorrectly formatted Excel file at line number "+i);
														return callback("Incorrectly formatted Excel file at line number "+i );
													}
												}
												else{
													//Unlock the tables
													connection.query('unlock tables', function(error, results){
														if(error) throw error;
														else{
															connection.end();
															resolve(results);
															return callback(null, results);
														}
													});
												}
											});
										}
									});
								}
							});
						});
					});
				}
				else{
					//If the file is not a csv format but regular excel format (xls/xlsx)
					readExcel(fs.createReadStream(data.path)).then((rows) => {
						var progress = 1;
						var tableString = '';
						if(options.customStartEnd === true){
							//No need to parse the all the rows
							if(options.startRow && options.startCol && options.endRow && options.endCol){
								sRow = options.startRow-1;
								eRow = options.endRow;
								sCol = options.startCol-1;
								eCol = options.endCol;
							}
							else{
								reject("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
								return callback("Custom Start End requires all 4 points to be declared, i.e., Start Row, Start Column, End Row, End Column. It Seems one or more end points are not declared.");
							}
						}
						else{
							eCol = rows[0].length;
							eRow = rows.length;
						}
						//Make the string to insert as a query in MySQL
						if(options.autoId){
							tableString+='id int,';
						}
						//Scan the second row to check for the datatypes.
						//In case of numbers, we scan the whole column to make sure the datatype is int or float.
						for(var i=sCol;i<eCol;i++){
							noOfOperations = 0;
							checkInt = true;
							rows[sRow][i] = rows[sRow][i].toString().split(" ").join("_");
							tableString+=rows[sRow][i]+" ";
							//Check if the input is a number
							if(typeof(rows[sRow+1][i]) === 'number'){
								for(var j=sRow+1;j<eRow;j++){
									if(!isInt(rows[j][i])){
										//Check if it is float
										tableString+="float,";
										checkInt = false;
										break;
									}
									tableString+=returnString(eRow-1, rows[sRow+1][i]);
								}
							}
							//If the data is a string
							else if(typeof(rows[sRow+1][i]) === 'string'){
								tableString+="text,";
							}
							//MS Excel date is object in javascript.
							else if(typeof(rows[sRow+1][i]) === 'object'){
								if(isDate(rows[sRow+1][i])){
									tableString+="date,";
									for(var j=sRow+1;j<eRow;j++){
										rows[j][i] = formatDate(rows[j][i]);
									}
								}
								else{
									//In case of unsupported datatype
									reject("Datatype unsupported!");
									return callback("Datatype unsupported!");
								}
							}
							//0 or 1 also corresponds to bool
							else if(typeof(rows[sRow+1][i])==='boolean'){
								tableString+="bool,";
							}
						}
						tableString = tableString.replace(/.$/,"");
						connection.query('create database if not exists ' + data.db + ';use ' + data.db +';create table if not exists '+data.table+' ('+tableString+')', function(error, results){
							if(options.verbose){
								console.log('Table created!');
							}
							if(error){
								if(error.code=='ER_PARSE_ERROR'){
									reject('It seems that the column heading are not in text format.');
									return callback('It seems that the column heading are not in text format.');
								}
								else{
									reject(error);
									return callback(error);
								}
							}
							else{
								//Create the string first and then insert the full data at once.
								//The db operations are a bit slow in comparison to js.
								var insertString = '';
								for(var i=sRow+1;i<eRow;i++){
									insertString+='(';
									if(options.autoId){
										insertString+=i+",";
									}
									for(var j=sCol;j<eCol;j++){
										if(!rows[i]){
											reject('End points may be defined out of bounds in reference to the file.');
											return callback('End points may be defined out of bounds in reference to the file.');
										}
										if(rows[i][j] === true){
											insertString+="1,"
										}
										else if(rows[i][j] === false){
											insertString+="0,"
										}
										else{
											insertString+="\""+rows[i][j]+"\",";
										}
									}
									//Remove the trailing commas and spaces
									insertString = insertString.replace(/.$/,"");
									insertString+='),';
								}
								insertString = insertString.replace(/.$/,'');
								//Acquires lock on the table to allow concurrent operations.
								//This is done to avoid the irregular insertion in the database.
								connection.query('Lock tables '+data.table+' write', function(error, results){
									if(error) throw error;
									else{
										connection.query('insert into '+data.table+' values'+insertString, function(error, results){
											if(options.verbose){
												console.log('Inserting data!');
											}
											if(error){
												//Unlock the tables
												connection.query('unlock tables', function(error, results){
													if(error) throw error;
													else{
														connection.end();
													}
												});
												if(error.code == 'ER_WRONG_VALUE_COUNT_ON_ROW'){
													reject('The table you provided either already contains some data or there is a problem with the already prevailing column count.');
													return callback('The table you provided either already contains some data or there is a problem with the already prevailing column count.');
												}
												else{
													reject("Incorrectly formatted Excel file at line number "+i);
													return callback("Incorrectly formatted Excel file at line number "+i );
												}
											}
											else{
												//Unlock the tables
												connection.query('unlock tables', function(error, results){
													if(error) throw error;
													else{
														connection.end();
														resolve(results);
														return callback(null, results);
													}
												});
											}
										});
									}
								});
							}
						});
					});
				}
			}
		});
	});
}