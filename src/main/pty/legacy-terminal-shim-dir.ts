import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderLegacyTerminalPosixTombstone } from './legacy-terminal-posix-tombstone'

const LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY = 'ORCA_ENABLE_GIT_ATTRIBUTION'
const LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY = 'ORCA_ATTRIBUTION_BYPASS'

const LEGACY_SHIM_ROOT_DIR = 'orca-terminal-attribution'
// Why: must differ from the retired shim's own '7'. A rolled-back build compares this marker and
// skips rewriting its wrappers when it matches, which would leave our tombstones in place while
// its attribution toggle claimed to be on.
const LEGACY_SHIM_VERSION = '7-neutralized'
const NEUTRALIZATION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000]
export const LEGACY_TERMINAL_SHIM_ENV_KEYS = [
  'ORCA_ENABLE_GIT_ATTRIBUTION',
  'ORCA_GIT_COMMIT_TRAILER',
  'ORCA_GH_PR_FOOTER',
  'ORCA_GH_ISSUE_FOOTER',
  'ORCA_ATTRIBUTION_SHIM_DIR',
  'ORCA_REAL_GIT',
  'ORCA_REAL_GH',
  LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY
] as const
export const LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS = [
  LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY
] as const

const WIN32_PASSTHROUGH_WRAPPER = String.raw`@echo off
setlocal
set "orca_real=%ORCA_REAL___ORCA_UPPER_COMMAND__%"
set "orca_wrapper_dir=%~dp0"
set "orca_legacy_wrapper_dir=%ORCA_ATTRIBUTION_SHIM_DIR%"
set "orca_clean_path="
for %%P in ("%PATH:;=" "%") do call :orca_append_path "%%~P"
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
rem Why: clear a captured path that no longer exists, or the where.exe fallback below is skipped.
if defined orca_real if not exist "%orca_real%" set "orca_real="
if defined orca_real goto run
for /f "delims=" %%G in ('where.exe __ORCA_COMMAND__.exe 2^>nul') do if not defined orca_real set "orca_real=%%G"
if not defined orca_real (
  echo Orca compatibility wrapper could not locate __ORCA_COMMAND__ on PATH. 1>&2
  exit /b 127
)
:run
"%orca_real%" %*
exit /b %ERRORLEVEL%

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
  $resolved = Get-Command "$commandName.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $realCommand = if ($resolved) { $resolved.Source } else { $null }
}
if (-not $realCommand) {
  [Console]::Error.WriteLine("Orca compatibility wrapper could not locate $commandName on PATH.")
  exit 127
}
& $realCommand @args
exit $LASTEXITCODE
`

let neutralized = false
let neutralizationRetryTimer: ReturnType<typeof setTimeout> | null = null
let neutralizationRetryAttempt = 0

export function neutralizeLegacyTerminalShimDir(userDataPath: string): void {
  if (neutralized) {
    return
  }
  const rootDir = join(userDataPath, LEGACY_SHIM_ROOT_DIR)
  // Why: only installs that actually ran the shim have resolved wrapper paths worth keeping
  // alive. Writing them anywhere else would recreate the directory the removal deleted.
  if (!existsSync(rootDir)) {
    neutralized = true
    clearNeutralizationRetry()
    return
  }
  try {
    writeNeutralWrappers(rootDir)
    writeFileAtomically(join(rootDir, 'VERSION'), `${LEGACY_SHIM_VERSION}\n`, 0o644)
    neutralized = true
    clearNeutralizationRetry()
  } catch (error) {
    // Why: Windows can keep a running .cmd open briefly after startup.
    console.warn(
      `[legacy-terminal-shim] neutralization attempt ${neutralizationRetryAttempt + 1} failed:`,
      error instanceof Error ? error.message : String(error)
    )
    scheduleNeutralizationRetry(userDataPath)
  }
}

function scheduleNeutralizationRetry(userDataPath: string): void {
  if (neutralizationRetryTimer) {
    return
  }
  if (neutralizationRetryAttempt >= NEUTRALIZATION_RETRY_DELAYS_MS.length) {
    // Why: retries stop here for the process lifetime; without this the give-up is invisible and a
    // host left holding live wrappers is undiagnosable.
    // Why: +1 counts the initial attempt, so this agrees with the per-attempt line above.
    console.warn(
      `[legacy-terminal-shim] gave up neutralizing after ${neutralizationRetryAttempt + 1} attempts; legacy git/gh wrappers may remain until the next launch`
    )
    return
  }
  const delayMs = NEUTRALIZATION_RETRY_DELAYS_MS[neutralizationRetryAttempt]
  neutralizationRetryAttempt += 1
  neutralizationRetryTimer = setTimeout(() => {
    neutralizationRetryTimer = null
    neutralizeLegacyTerminalShimDir(userDataPath)
  }, delayMs)
  neutralizationRetryTimer.unref?.()
}

function clearNeutralizationRetry(): void {
  if (neutralizationRetryTimer) {
    clearTimeout(neutralizationRetryTimer)
    neutralizationRetryTimer = null
  }
  neutralizationRetryAttempt = 0
}

function writeNeutralWrappers(rootDir: string): void {
  const posixDir = join(rootDir, 'posix')
  const win32Dir = join(rootDir, 'win32')
  mkdirSync(posixDir, { recursive: true })
  mkdirSync(win32Dir, { recursive: true })
  for (const command of ['git', 'gh'] as const) {
    const upperCommand = command.toUpperCase()
    writeFileAtomically(join(posixDir, command), renderLegacyTerminalPosixTombstone(command), 0o755)
    writeFileAtomically(
      join(win32Dir, `${command}.cmd`),
      renderWindowsWrapper(WIN32_PASSTHROUGH_WRAPPER, command, upperCommand),
      0o755
    )
    writeFileAtomically(
      join(win32Dir, `${command}-wrapper.ps1`),
      renderWindowsWrapper(POWERSHELL_PASSTHROUGH_WRAPPER, command, upperCommand),
      0o755
    )
  }
}

function renderWindowsWrapper(template: string, command: string, upperCommand: string): string {
  return template
    .replaceAll('__ORCA_UPPER_COMMAND__', upperCommand)
    .replaceAll('__ORCA_COMMAND__', command)
}

function writeFileAtomically(filePath: string, contents: string, mode: number): void {
  const temporaryPath = `${filePath}.orca-neutralizing-${process.pid}`
  try {
    rmSync(temporaryPath, { force: true, recursive: true })
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, filePath)
  } finally {
    try {
      rmSync(temporaryPath, { force: true, recursive: true })
    } catch {
      // Why: a locked temp file must not replace the in-flight error with a cleanup error.
    }
  }
}

export function isLegacyTerminalShimPathEntry(entry: string): boolean {
  const normalized = entry.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return (
    normalized.endsWith(`/${LEGACY_SHIM_ROOT_DIR}/posix`) ||
    normalized.endsWith(`/${LEGACY_SHIM_ROOT_DIR}/win32`)
  )
}

export function stripLegacyTerminalShimEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  const windows = platform === 'win32'
  const legacyKeySet = new Set(
    LEGACY_TERMINAL_SHIM_ENV_KEYS.map((key) => (windows ? key.toLowerCase() : key))
  )
  const shimDirKey = 'ORCA_ATTRIBUTION_SHIM_DIR'.toLowerCase()
  const explicitShimDirs = Object.entries(env)
    .filter(([key]) =>
      windows ? key.toLowerCase() === shimDirKey : key === 'ORCA_ATTRIBUTION_SHIM_DIR'
    )
    .map(([, value]) => value)
    .filter(Boolean)
  for (const key of Object.keys(env)) {
    if (windows ? legacyKeySet.has(key.toLowerCase()) : legacyKeySet.has(key)) {
      delete env[key]
    }
  }
  const delimiter = windows ? ';' : ':'
  const pathKeys = windows
    ? Object.keys(env).filter((key) => key.toLowerCase() === 'path')
    : ['PATH']
  for (const pathKey of pathKeys) {
    const current = env[pathKey]
    if (!current) {
      continue
    }
    const withoutExplicitDirs = explicitShimDirs.reduce(
      (pathValue, shimDir) => removeLiteralPathEntry(pathValue, shimDir, delimiter, windows),
      current
    )
    const cleaned = withoutExplicitDirs
      .split(delimiter)
      .filter((entry) => entry && !isLegacyTerminalShimPathEntry(entry))
      .join(delimiter)
    if (cleaned) {
      env[pathKey] = cleaned
    } else {
      delete env[pathKey]
    }
  }
}

function removeLiteralPathEntry(
  pathValue: string,
  entry: string,
  delimiter: string,
  caseInsensitive: boolean
): string {
  let result = pathValue
  const needle = caseInsensitive ? entry.toLowerCase() : entry
  let searchStart = 0
  for (;;) {
    const comparable = caseInsensitive ? result.toLowerCase() : result
    const index = comparable.indexOf(needle, searchStart)
    if (index === -1) {
      return result
    }
    const end = index + entry.length
    const startsAtBoundary = index === 0 || result[index - 1] === delimiter
    const endsAtBoundary = end === result.length || result[end] === delimiter
    if (!startsAtBoundary || !endsAtBoundary) {
      searchStart = index + 1
      continue
    }
    if (result[end] === delimiter) {
      result = result.slice(0, index) + result.slice(end + 1)
    } else if (index > 0) {
      result = result.slice(0, index - 1) + result.slice(end)
    } else {
      result = ''
    }
    searchStart = Math.max(0, index - 1)
  }
}

/** Test-only: the module-level once-guard would otherwise leak across cases. */
export function __resetLegacyTerminalShimNeutralizationForTests(): void {
  neutralized = false
  clearNeutralizationRetry()
}
