// Why: kept beside the POSIX tombstone so the generated wrapper text for every platform lives
// in one place, and so the shim-dir module stays under the max-lines limit.

const WIN32_PASSTHROUGH_WRAPPER = String.raw`@echo off
setlocal
set "orca_real=%ORCA_REAL___ORCA_UPPER_COMMAND__%"
set "orca_wrapper_dir=%~dp0"
set "orca_legacy_wrapper_dir=%ORCA_ATTRIBUTION_SHIM_DIR%"
set "orca_clean_path="
rem Why: an empty PATH leaves the substitution below with an unbalanced quote, which
rem desynchronizes cmd parsing for the rest of the file. Skip the line entirely instead.
if not defined PATH goto :orca_path_walked
for %%P in ("%PATH:;=" "%") do call :orca_append_path "%%~P"
:orca_path_walked
set "PATH=%orca_clean_path%"
set "ORCA_ENABLE_GIT_ATTRIBUTION="
set "ORCA_GIT_COMMIT_TRAILER="
set "ORCA_GH_PR_FOOTER="
set "ORCA_GH_ISSUE_FOOTER="
set "ORCA_ATTRIBUTION_SHIM_DIR="
set "ORCA_ATTRIBUTION_BYPASS="
set "ORCA_REAL_GIT="
set "ORCA_REAL_GH="
if defined orca_real for %%G in ("%orca_real%") do if /I "%%~dpG"=="%~dp0" set "orca_real="
rem Why: clear a captured path that no longer exists, or the PATH walk below is skipped.
if defined orca_real if not exist "%orca_real%" set "orca_real="
if defined orca_real goto run
rem Why: an unqualified Windows command lookup searches the current directory before PATH, so a
rem repository-local __ORCA_COMMAND__.exe would win. Walk the cleaned PATH ourselves instead.
if not defined orca_clean_path goto :orca_candidates_walked
for %%P in ("%orca_clean_path:;=" "%") do call :orca_try_candidate "%%~P"
:orca_candidates_walked
if not defined orca_real (
  echo Orca compatibility wrapper could not locate __ORCA_COMMAND__ on PATH. 1>&2
  exit /b 127
)
:run
"%orca_real%" %*
exit /b %ERRORLEVEL%

:orca_try_candidate
if defined orca_real exit /b
if "%~1"=="" exit /b
rem Why: a relative entry resolves against the current directory, same exposure as an empty one.
rem Tested in pure batch on purpose: an external tool invoked here would itself be resolved from
rem the current directory, reintroducing the very hijack this guard exists to prevent.
set "orca_candidate=%~1"
if "%orca_candidate:~0,2%"=="\\" goto orca_candidate_rooted
if "%orca_candidate:~1,2%"==":\" goto orca_candidate_rooted
if "%orca_candidate:~1,2%"==":/" goto orca_candidate_rooted
exit /b
:orca_candidate_rooted
rem Why: %~dp0 is rebound to this label inside CALL, so compare against the cached wrapper dir.
for %%G in ("%~1") do (
  if /I not "%%~fG\"=="%orca_wrapper_dir%" (
    if exist "%%~fG\__ORCA_COMMAND__.exe" set "orca_real=%%~fG\__ORCA_COMMAND__.exe"
    if not defined orca_real if exist "%%~fG\__ORCA_COMMAND__.cmd" set "orca_real=%%~fG\__ORCA_COMMAND__.cmd"
    if not defined orca_real if exist "%%~fG\__ORCA_COMMAND__.bat" set "orca_real=%%~fG\__ORCA_COMMAND__.bat"
  )
)
exit /b

:orca_append_path
for %%G in ("%~1") do set "orca_path_entry_dir=%%~fG\"
if /I "%orca_path_entry_dir%"=="%orca_wrapper_dir%" exit /b
if defined orca_legacy_wrapper_dir for %%G in ("%orca_legacy_wrapper_dir%") do if /I "%orca_path_entry_dir%"=="%%~fG\" exit /b
if defined orca_clean_path (set "orca_clean_path=%orca_clean_path%;%~1") else set "orca_clean_path=%~1"
exit /b
`

const POWERSHELL_PASSTHROUGH_WRAPPER = String.raw`$ErrorActionPreference = 'Stop'
$commandName = '__ORCA_COMMAND__'
$realCommand = [Environment]::GetEnvironmentVariable('ORCA_REAL___ORCA_UPPER_COMMAND__')
$wrapperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$legacyWrapperDir = $env:ORCA_ATTRIBUTION_SHIM_DIR
$wrapperDirs = @($wrapperDir, $legacyWrapperDir) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
$env:PATH = (($env:PATH -split ';') | Where-Object {
  $pathEntry = $_
  $pathEntry -and -not ($wrapperDirs | Where-Object {
    [string]::Equals($_, $pathEntry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  })
}) -join ';'
'ORCA_ENABLE_GIT_ATTRIBUTION', 'ORCA_GIT_COMMIT_TRAILER', 'ORCA_GH_PR_FOOTER', 'ORCA_GH_ISSUE_FOOTER', 'ORCA_ATTRIBUTION_SHIM_DIR', 'ORCA_REAL_GIT', 'ORCA_REAL_GH', 'ORCA_ATTRIBUTION_BYPASS' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
if ($realCommand) {
  try {
    $capturedDir = Split-Path -Parent ([IO.Path]::GetFullPath($realCommand))
    if ([string]::Equals($capturedDir.TrimEnd('\'), $wrapperDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      $realCommand = $null
    }
  } catch {
    $realCommand = $null
  }
}
if (-not $realCommand -or -not (Test-Path -LiteralPath $realCommand)) {
  # Why: resolve only against the cleaned PATH directories. Ambient lookup could pick up a
  # repository-local git.exe/gh.exe from the current directory.
  $realCommand = $null
  foreach ($dir in ($env:PATH -split ';')) {
    if (-not $dir) { continue }
    # Why: a relative entry resolves against the current directory, same exposure as an empty one.
    # IsPathRooted is not enough: it accepts drive-relative 'C:foo', which resolves against the
    # current directory on that drive. IsPathFullyQualified is absent on Windows PowerShell 5.1,
    # so match the same prefixes the cmd wrapper accepts.
    if ($dir -notmatch '^([A-Za-z]:[\\/]|\\\\)') { continue }
    if ($wrapperDirs | Where-Object { [string]::Equals($_, $dir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }) { continue }
    foreach ($ext in @('.exe', '.cmd', '.bat')) {
      $candidate = Join-Path $dir "$commandName$ext"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $realCommand = $candidate; break }
    }
    if ($realCommand) { break }
  }
}
if (-not $realCommand) {
  [Console]::Error.WriteLine("Orca compatibility wrapper could not locate $commandName on PATH.")
  exit 127
}
& $realCommand @args
exit $LASTEXITCODE
`

function renderWindowsWrapper(template: string, command: string, upperCommand: string): string {
  return template
    .replaceAll('__ORCA_UPPER_COMMAND__', upperCommand)
    .replaceAll('__ORCA_COMMAND__', command)
}

export function renderLegacyTerminalWindowsCmdTombstone(command: 'git' | 'gh'): string {
  return renderWindowsWrapper(WIN32_PASSTHROUGH_WRAPPER, command, command.toUpperCase())
}

export function renderLegacyTerminalWindowsPowerShellTombstone(command: 'git' | 'gh'): string {
  return renderWindowsWrapper(POWERSHELL_PASSTHROUGH_WRAPPER, command, command.toUpperCase())
}
