@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "RESOURCES_DIR=%%~fI"
for %%I in ("%RESOURCES_DIR%..") do set "APP_DIR=%%~fI"
set "ELECTRON=%APP_DIR%\Orca.exe"

if not exist "%ELECTRON%" (
  echo Unable to locate Orca.exe next to "%RESOURCES_DIR%" 1>&2
  exit /b 1
)

REM Why: Orca packages the CLI entrypoint outside app.asar so the public shell
REM command can execute it directly with ELECTRON_RUN_AS_NODE instead of
REM depending on a separately installed Node CLI.
set "CLI=%RESOURCES_DIR%\app.asar.unpacked\out\cli\index.js"

set "ORCA_NODE_OPTIONS=%NODE_OPTIONS%"
set "ORCA_NODE_REPL_EXTERNAL_MODULE=%NODE_REPL_EXTERNAL_MODULE%"
set NODE_OPTIONS=
set NODE_REPL_EXTERNAL_MODULE=
set ELECTRON_RUN_AS_NODE=1

"%ELECTRON%" "%CLI%" %*
