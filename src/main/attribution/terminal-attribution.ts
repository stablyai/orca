/* eslint-disable max-lines -- Why: this module owns the generated git/gh wrapper
scripts for both POSIX shells and Windows shells. Keeping the scripts adjacent
to the env injection code makes the attribution behavior auditable as one unit
instead of scattering generated shell fragments across files. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const ATTRIBUTION_ROOT_DIR = 'orca-terminal-attribution'
const ATTRIBUTION_SHIM_VERSION = '5'
const ORCA_PRODUCT_URL = 'https://github.com/orca-ide'
const ORCA_GIT_COMMIT_TRAILER = 'Co-authored-by: Orca <help@stably.ai>'
const ORCA_GH_FOOTER = `Made with [Orca](${ORCA_PRODUCT_URL}) 🐋`
const SHELL_DOLLAR = '$'
const POWERSHELL_TICK = '`'

const writtenRoots = new Set<string>()

type AttributionShimPaths = {
  posixDir: string
  win32Dir: string
}

export function applyTerminalAttributionEnv(
  baseEnv: Record<string, string>,
  options: { enabled: boolean; userDataPath: string }
): Record<string, string> {
  if (!options.enabled) {
    return baseEnv
  }

  let shimPaths: AttributionShimPaths
  try {
    shimPaths = ensureAttributionShims(options.userDataPath)
  } catch {
    return baseEnv
  }

  const pathDelimiter = process.platform === 'win32' ? ';' : ':'
  const basePath = baseEnv.PATH ?? process.env.PATH ?? ''
  // Why: resolve real Windows commands before prepending shims so cmd wrappers
  // cannot recursively point ORCA_REAL_* at themselves.
  const resolvedGit =
    process.platform === 'win32' ? resolveWindowsExecutable('git', basePath) : null
  const resolvedGh = process.platform === 'win32' ? resolveWindowsExecutable('gh', basePath) : null
  const { posixDir, win32Dir } = shimPaths
  // Why: Windows terminals may be cmd/PowerShell or Git Bash. Include both shim
  // families; native shells ignore extensionless POSIX files, Git Bash can use them.
  const prependDirs = process.platform === 'win32' ? [posixDir, win32Dir] : [posixDir]

  // Why: these wrappers should affect only Orca-managed PTYs. Prepending the
  // shim directory here keeps the attribution behavior scoped to Orca's live
  // terminal environment instead of mutating global git/gh config or the
  // user's external shell PATH.
  baseEnv.PATH = [...prependDirs, basePath].filter(Boolean).join(pathDelimiter)
  baseEnv.ORCA_ENABLE_GIT_ATTRIBUTION = '1'
  baseEnv.ORCA_GIT_COMMIT_TRAILER = ORCA_GIT_COMMIT_TRAILER
  baseEnv.ORCA_GH_PR_FOOTER = ORCA_GH_FOOTER
  baseEnv.ORCA_GH_ISSUE_FOOTER = ORCA_GH_FOOTER

  if (process.platform === 'win32') {
    if (resolvedGit) {
      baseEnv.ORCA_REAL_GIT = resolvedGit
    }
    if (resolvedGh) {
      baseEnv.ORCA_REAL_GH = resolvedGh
    }
  }

  return baseEnv
}

function ensureAttributionShims(userDataPath: string): AttributionShimPaths {
  const rootDir = join(userDataPath, ATTRIBUTION_ROOT_DIR)
  const posixDir = join(rootDir, 'posix')
  const win32Dir = join(rootDir, 'win32')
  const versionFile = join(rootDir, 'VERSION')

  if (writtenRoots.has(rootDir)) {
    return { posixDir, win32Dir }
  }

  if (readShimVersion(versionFile) === ATTRIBUTION_SHIM_VERSION) {
    writtenRoots.add(rootDir)
    return { posixDir, win32Dir }
  }

  mkdirSync(posixDir, { recursive: true })
  mkdirSync(win32Dir, { recursive: true })

  writeExecutable(join(posixDir, 'git'), POSIX_GIT_WRAPPER)
  writeExecutable(join(posixDir, 'gh'), POSIX_GH_WRAPPER)

  writeExecutable(join(win32Dir, 'git.cmd'), WIN32_GIT_CMD_WRAPPER)
  writeExecutable(join(win32Dir, 'gh.cmd'), WIN32_GH_CMD_WRAPPER)
  writeExecutable(join(win32Dir, 'git-wrapper.ps1'), WIN32_GIT_PS_WRAPPER)
  writeExecutable(join(win32Dir, 'gh-wrapper.ps1'), WIN32_GH_PS_WRAPPER)
  writeFileSync(versionFile, `${ATTRIBUTION_SHIM_VERSION}\n`, 'utf8')

  writtenRoots.add(rootDir)

  return { posixDir, win32Dir }
}

function readShimVersion(versionFile: string): string | null {
  try {
    return readFileSync(versionFile, 'utf8').trim()
  } catch {
    return null
  }
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, 'utf8')
  chmodSync(filePath, 0o755)
}

function resolveWindowsExecutable(command: string, pathValue: string): string | null {
  const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.toLowerCase())
  const searchDirs = pathValue.split(';').filter(Boolean)

  for (const dir of searchDirs) {
    for (const ext of pathExt) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) {
        return candidate
      }
    }
    const bareCandidate = join(dir, command)
    if (existsSync(bareCandidate)) {
      return bareCandidate
    }
  }

  return null
}

const POSIX_COMMON = String.raw`#!/usr/bin/env bash
set -euo pipefail

clean_path() {
  local current_path="${SHELL_DOLLAR}{PATH:-}"
  local script_dir
  script_dir="$(cd -- "$(dirname "${SHELL_DOLLAR}{BASH_SOURCE[0]}")" && pwd)"
  local cleaned=()
  local entry
  IFS=':' read -r -a entries <<<"$current_path"
  for entry in "${SHELL_DOLLAR}{entries[@]}"; do
    case "$entry" in
      "$script_dir"|*/orca-terminal-attribution/posix|*/orca-terminal-attribution/win32|*\\orca-terminal-attribution\\posix|*\\orca-terminal-attribution\\win32)
        ;;
      *)
        cleaned+=("$entry")
        ;;
    esac
  done
  (IFS=':'; printf '%s' "${SHELL_DOLLAR}{cleaned[*]:-}")
}
`

const POSIX_GIT_WRAPPER = `${POSIX_COMMON}
real_path="$(clean_path)"
real_git="$(PATH="$real_path" command -v git || true)"
if [[ -z "$real_git" ]]; then
  echo "Orca attribution wrapper could not locate git on PATH." >&2
  exit 127
fi

if [[ "\${ORCA_ENABLE_GIT_ATTRIBUTION:-0}" != "1" || "\${ORCA_ATTRIBUTION_BYPASS:-0}" == "1" || "\${1:-}" != "commit" ]]; then
  PATH="$real_path" exec "$real_git" "$@"
fi

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      PATH="$real_path" exec "$real_git" "$@"
      ;;
  esac
done

should_skip_signed_commit_attribution() {
  local saw_no_gpg_sign=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --no-gpg-sign)
        saw_no_gpg_sign=1
        ;;
      --gpg-sign|--gpg-sign=*|-S|-S*)
        return 0
        ;;
    esac
  done
  if [[ $saw_no_gpg_sign -eq 1 ]]; then
    return 1
  fi
  [[ "$(PATH="$real_path" "$real_git" config --bool commit.gpgsign 2>/dev/null || true)" == "true" ]]
}

if should_skip_signed_commit_attribution "$@"; then
  PATH="$real_path" exec "$real_git" "$@"
fi

before_head="$(
  PATH="$real_path" "$real_git" rev-parse --verify HEAD 2>/dev/null || true
)"

PATH="$real_path" "$real_git" "$@"
status=$?
if [[ $status -ne 0 ]]; then
  exit $status
fi

after_head="$(
  PATH="$real_path" "$real_git" rev-parse --verify HEAD 2>/dev/null || true
)"
if [[ -z "$after_head" || "$before_head" == "$after_head" ]]; then
  exit 0
fi

message="$(
  PATH="$real_path" "$real_git" log -1 --format=%B 2>/dev/null || true
)"
trailer="\${ORCA_GIT_COMMIT_TRAILER:-Co-authored-by: Orca <help@stably.ai>}"
if grep -Fqi "$trailer" <<<"$message"; then
  exit 0
fi

tmp_file="$(mktemp)"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

if [[ -n "$message" ]]; then
  printf '%s\n\n%s\n' "$message" "$trailer" >"$tmp_file"
else
  printf '%s\n' "$trailer" >"$tmp_file"
fi

# Why: git commit has no generic "post-success message transformer" hook. The
# wrapper amends only the just-created commit so Orca can add attribution
# without mutating repo config or installing hooks into the user's checkout. The
# amend is best-effort so attribution cannot turn a successful user commit into
# a failed terminal command.
ORCA_ATTRIBUTION_BYPASS=1 PATH="$real_path" "$real_git" commit --amend --no-verify -F "$tmp_file" >/dev/null 2>/dev/null || true
`

const POSIX_GH_WRAPPER = `${POSIX_COMMON}
real_path="$(clean_path)"
real_gh="$(PATH="$real_path" command -v gh || true)"
if [[ -z "$real_gh" ]]; then
  echo "Orca attribution wrapper could not locate gh on PATH." >&2
  exit 127
fi

append_footer() {
  local kind="$1"
  local url_pattern="$2"
  local footer="$3"
  local stdout_capture="$4"
  local stderr_capture="$5"
  local url=""

  url="$(printf '%s\n%s\n' "$stdout_capture" "$stderr_capture" | grep -Eo "$url_pattern" | tail -n 1 || true)"
  append_footer_url "$kind" "$footer" "$url"
}

append_footer_url() {
  local kind="$1"
  local footer="$2"
  local url="$3"

  if [[ -z "$url" ]]; then
    return 0
  fi

  local api_path
  api_path="$(github_api_path "$kind" "$url" || true)"
  if [[ -z "$api_path" ]]; then
    return 0
  fi

  local body
  if ! body="$(PATH="$real_path" "$real_gh" api "$api_path" --jq '.body // ""' 2>/dev/null)"; then
    return 0
  fi
  if grep -Fqi "$footer" <<<"$body"; then
    return 0
  fi

  local tmp_file
  tmp_file="$(mktemp)"
  if [[ -n "$body" ]]; then
    printf '%s\n\n%s\n' "$body" "$footer" >"$tmp_file"
  else
    printf '%s\n' "$footer" >"$tmp_file"
  fi
  # Why: gh exposes create output as a URL, but does not provide a transactional
  # body append. Use REST instead of gh pr/issue edit because those commands can
  # hit unrelated GraphQL fields, while the URL maps directly to one REST item.
  PATH="$real_path" "$real_gh" api -X PATCH "$api_path" -f "body=$(cat "$tmp_file")" >/dev/null || true
  rm -f "$tmp_file"
}

github_api_path() {
  local kind="$1"
  local url="$2"
  if [[ "$kind" == "pr" && "$url" =~ ^https://github[.]com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
    printf 'repos/%s/%s/pulls/%s' "${SHELL_DOLLAR}{BASH_REMATCH[1]}" "${SHELL_DOLLAR}{BASH_REMATCH[2]}" "${SHELL_DOLLAR}{BASH_REMATCH[3]}"
    return 0
  fi
  if [[ "$kind" == "issue" && "$url" =~ ^https://github[.]com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
    printf 'repos/%s/%s/issues/%s' "${SHELL_DOLLAR}{BASH_REMATCH[1]}" "${SHELL_DOLLAR}{BASH_REMATCH[2]}" "${SHELL_DOLLAR}{BASH_REMATCH[3]}"
    return 0
  fi
  return 1
}

has_noninteractive_create_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --title|-t|--title=*|--body|-b|--body=*|--body-file|-F|--body-file=*|--fill|--fill-first|--fill-verbose|--template|-T|--template=*|--recover|--recover=*|--web)
        return 0
        ;;
    esac
  done
  return 1
}

has_passthrough_create_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --help|-h|--version)
        return 0
        ;;
    esac
  done
  return 1
}

if [[ "\${ORCA_ENABLE_GIT_ATTRIBUTION:-0}" != "1" || "\${ORCA_ATTRIBUTION_BYPASS:-0}" == "1" ]]; then
  PATH="$real_path" exec "$real_gh" "$@"
fi

if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then
  footer="\${ORCA_GH_PR_FOOTER:-Made with [Orca](https://github.com/orca-ide) 🐋}"
  if has_passthrough_create_args "$@"; then
    PATH="$real_path" exec "$real_gh" "$@"
  fi
  if ! has_noninteractive_create_args "$@"; then
    # Why: gh switches off interactive prompts when stdout/stderr are redirected,
    # and post-create "pr view" can select the wrong PR in fork/multi-PR cases.
    # Preserve interactive UX and skip attribution rather than guessing.
    PATH="$real_path" exec "$real_gh" "$@"
  fi
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  cleanup_capture() {
    rm -f "$stdout_file" "$stderr_file"
  }
  trap cleanup_capture EXIT
  if PATH="$real_path" "$real_gh" "$@" >"$stdout_file" 2>"$stderr_file"; then
    status=0
  else
    status=$?
  fi
  stdout_capture="$(cat "$stdout_file")"
  stderr_capture="$(cat "$stderr_file")"
  cat "$stderr_file" >&2
  cat "$stdout_file"
  if [[ $status -eq 0 ]]; then
    append_footer "pr" 'https://github.com/[^[:space:]]+/pull/[0-9]+' "$footer" "$stdout_capture" "$stderr_capture"
  fi
  cleanup_capture
  trap - EXIT
  exit $status
fi

if [[ "\${1:-}" == "issue" && "\${2:-}" == "create" ]]; then
  footer="\${ORCA_GH_ISSUE_FOOTER:-Made with [Orca](https://github.com/orca-ide) 🐋}"
  if has_passthrough_create_args "$@"; then
    PATH="$real_path" exec "$real_gh" "$@"
  fi
  if ! has_noninteractive_create_args "$@"; then
    # Why: gh issue create also requires a live TTY for prompts, but gh has no
    # current-issue lookup equivalent to "pr view". Do not guess with issue list:
    # that can edit an unrelated issue if the command printed no URL.
    PATH="$real_path" exec "$real_gh" "$@"
  fi
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  cleanup_capture() {
    rm -f "$stdout_file" "$stderr_file"
  }
  trap cleanup_capture EXIT
  if PATH="$real_path" "$real_gh" "$@" >"$stdout_file" 2>"$stderr_file"; then
    status=0
  else
    status=$?
  fi
  stdout_capture="$(cat "$stdout_file")"
  stderr_capture="$(cat "$stderr_file")"
  cat "$stderr_file" >&2
  cat "$stdout_file"
  if [[ $status -eq 0 ]]; then
    append_footer "issue" 'https://github.com/[^[:space:]]+/issues/[0-9]+' "$footer" "$stdout_capture" "$stderr_capture"
  fi
  cleanup_capture
  trap - EXIT
  exit $status
fi

PATH="$real_path" exec "$real_gh" "$@"
`

const WIN32_GIT_CMD_WRAPPER = String.raw`@echo off
setlocal
if not "%ORCA_ENABLE_GIT_ATTRIBUTION%"=="1" goto run
if "%ORCA_ATTRIBUTION_BYPASS%"=="1" goto run
if /I not "%~1"=="commit" goto run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0git-wrapper.ps1" %*
exit /b %ERRORLEVEL%
:run
if defined ORCA_REAL_GIT (
  "%ORCA_REAL_GIT%" %*
) else (
  echo Orca attribution wrapper could not locate git on PATH. 1>&2
  exit /b 127
)
exit /b %ERRORLEVEL%
`

const WIN32_GH_CMD_WRAPPER = String.raw`@echo off
setlocal
if not "%ORCA_ENABLE_GIT_ATTRIBUTION%"=="1" goto run
if "%ORCA_ATTRIBUTION_BYPASS%"=="1" goto run
if /I "%~1"=="pr" if /I "%~2"=="create" goto wrap
if /I "%~1"=="issue" if /I "%~2"=="create" goto wrap
goto run
:wrap
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-wrapper.ps1" %*
exit /b %ERRORLEVEL%
:run
if defined ORCA_REAL_GH (
  "%ORCA_REAL_GH%" %*
) else (
  echo Orca attribution wrapper could not locate gh on PATH. 1>&2
  exit /b 127
)
exit /b %ERRORLEVEL%
`

const WIN32_GIT_PS_WRAPPER = String.raw`$ErrorActionPreference = 'Stop'
$realGit = if ($env:ORCA_REAL_GIT) { $env:ORCA_REAL_GIT } else { 'git' }
$trailer = if ($env:ORCA_GIT_COMMIT_TRAILER) { $env:ORCA_GIT_COMMIT_TRAILER } else { 'Co-authored-by: Orca <help@stably.ai>' }

if ($args -contains '--dry-run') {
  & $realGit @args
  exit $LASTEXITCODE
}

function Test-SignedCommitAttributionSkip {
  $sawNoGpgSign = $false
  foreach ($arg in $args) {
    if ($arg -eq '--no-gpg-sign') {
      $sawNoGpgSign = $true
    } elseif ($arg -eq '--gpg-sign' -or $arg.StartsWith('--gpg-sign=') -or $arg -eq '-S' -or $arg.StartsWith('-S')) {
      return $true
    }
  }
  if ($sawNoGpgSign) {
    return $false
  }
  $gpgSign = (& $realGit config --bool commit.gpgsign 2>$null)
  return $LASTEXITCODE -eq 0 -and $gpgSign -eq 'true'
}

if (Test-SignedCommitAttributionSkip) {
  & $realGit @args
  exit $LASTEXITCODE
}

$beforeHead = (& $realGit rev-parse --verify HEAD 2>$null)
& $realGit @args
$status = $LASTEXITCODE
if ($status -ne 0) {
  exit $status
}

$afterHead = (& $realGit rev-parse --verify HEAD 2>$null)
if ([string]::IsNullOrWhiteSpace($afterHead) -or $beforeHead -eq $afterHead) {
  exit 0
}

$message = (& $realGit log -1 --format=%B 2>$null) | Out-String
if ($message -match [Regex]::Escape($trailer)) {
  exit 0
}

$tmpFile = [System.IO.Path]::GetTempFileName()
try {
  $trimmed = $message.TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n")
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    Set-Content -LiteralPath $tmpFile -Value $trailer -NoNewline
  } else {
    Set-Content -LiteralPath $tmpFile -Value ($trimmed + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $trailer) -NoNewline
  }
  $env:ORCA_ATTRIBUTION_BYPASS = '1'
  & $realGit commit --amend --no-verify -F $tmpFile 2>$null | Out-Null
  exit 0
} finally {
  Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
}
`

const WIN32_GH_PS_WRAPPER = String.raw`$ErrorActionPreference = 'Stop'
$realGh = if ($env:ORCA_REAL_GH) { $env:ORCA_REAL_GH } else { 'gh' }

function Test-NonInteractiveCreateArgs {
  param([string[]]$CommandArgs)
  foreach ($arg in $CommandArgs) {
    if ($arg -match '^(--title|-t|--body|-b|--body-file|-F|--fill|--fill-first|--fill-verbose|--template|-T|--recover|--web)(=|$)') {
      return $true
    }
  }
  return $false
}

function Test-PassthroughCreateArgs {
  param([string[]]$CommandArgs)
  foreach ($arg in $CommandArgs) {
    if ($arg -eq '--help' -or $arg -eq '-h' -or $arg -eq '--version') {
      return $true
    }
  }
  return $false
}

function Add-Footer {
  param([string]$Kind, [string]$CreatedUrl, [string]$Footer)
  if (-not $CreatedUrl) {
    return
  }
  $apiPath = Get-GitHubApiPath $Kind $CreatedUrl
  if (-not $apiPath) {
    return
  }
  $body = (& $realGh api $apiPath --jq '.body // ""' 2>$null) | Out-String
  if ($LASTEXITCODE -ne 0 -or $body -match [Regex]::Escape($Footer)) {
    return
  }
  $tmpFile = [System.IO.Path]::GetTempFileName()
  try {
    $trimmed = $body.TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n")
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      Set-Content -LiteralPath $tmpFile -Value $Footer -NoNewline
    } else {
      Set-Content -LiteralPath $tmpFile -Value ($trimmed + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $Footer) -NoNewline
    }
    try {
      & $realGh api -X PATCH $apiPath -f "body=$(Get-Content -LiteralPath $tmpFile -Raw)" | Out-Null
    } catch {
    }
  } finally {
    Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
  }
}

function Get-GitHubApiPath {
  param([string]$Kind, [string]$CreatedUrl)
  if ($Kind -eq 'pr' -and $CreatedUrl -match '^https://github\.com/([^/]+)/([^/]+)/pull/([0-9]+)') {
    return "repos/$($Matches[1])/$($Matches[2])/pulls/$($Matches[3])"
  }
  if ($Kind -eq 'issue' -and $CreatedUrl -match '^https://github\.com/([^/]+)/([^/]+)/issues/([0-9]+)') {
    return "repos/$($Matches[1])/$($Matches[2])/issues/$($Matches[3])"
  }
  return $null
}

$commandText = ($args -join ' ').ToLowerInvariant()
if (($commandText.StartsWith('pr create') -or $commandText.StartsWith('issue create')) -and (Test-PassthroughCreateArgs $args)) {
  & $realGh @args
  exit $LASTEXITCODE
}

if (($commandText.StartsWith('pr create') -or $commandText.StartsWith('issue create')) -and -not (Test-NonInteractiveCreateArgs $args)) {
  & $realGh @args
  $status = $LASTEXITCODE
  if ($status -ne 0) {
    exit $status
  }
  if ($commandText.StartsWith('pr create')) {
    exit 0
  } else {
    exit 0
  }
  exit 0
}

$stdoutFile = [System.IO.Path]::GetTempFileName()
$stderrFile = [System.IO.Path]::GetTempFileName()
& $realGh @args > $stdoutFile 2> $stderrFile
$status = $LASTEXITCODE
$stdoutCapture = if (Test-Path -LiteralPath $stdoutFile) { Get-Content -LiteralPath $stdoutFile -Raw } else { '' }
$stderrCapture = if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile -Raw } else { '' }
if ($stderrCapture) {
  [Console]::Error.Write($stderrCapture)
}
if ($status -ne 0) {
  if ($stdoutCapture) {
    [Console]::Out.Write($stdoutCapture)
  }
  Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  exit $status
}
if ($stdoutCapture) {
  [Console]::Out.Write($stdoutCapture)
}

if ($commandText.StartsWith('pr create')) {
  $createdUrl = ([regex]::Matches(($stdoutCapture + [Environment]::NewLine + $stderrCapture), 'https://github.com/\S+/pull/\d+') | Select-Object -Last 1).Value
  if ($createdUrl) {
    $apiPath = Get-GitHubApiPath 'pr' $createdUrl
    $body = if ($apiPath) { (& $realGh api $apiPath --jq '.body // ""' 2>$null) | Out-String } else { $null }
    if ($LASTEXITCODE -ne 0) {
      $body = $null
    }
    $footer = if ($env:ORCA_GH_PR_FOOTER) { $env:ORCA_GH_PR_FOOTER } else { 'Made with [Orca](https://github.com/orca-ide) 🐋' }
    if ($null -ne $body -and $body -notmatch [Regex]::Escape($footer)) {
      $tmpFile = [System.IO.Path]::GetTempFileName()
      try {
        $trimmed = $body.TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n")
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
          Set-Content -LiteralPath $tmpFile -Value $footer -NoNewline
        } else {
          Set-Content -LiteralPath $tmpFile -Value ($trimmed + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $footer) -NoNewline
        }
        # Why: gh has no transactional body append for newly-created PRs. This
        # immediate REST patch keeps attribution scoped to the URL gh returned.
        try {
          & $realGh api -X PATCH $apiPath -f "body=$(Get-Content -LiteralPath $tmpFile -Raw)" | Out-Null
        } catch {
        }
      } finally {
        Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

if ($commandText.StartsWith('issue create')) {
  $createdUrl = ([regex]::Matches(($stdoutCapture + [Environment]::NewLine + $stderrCapture), 'https://github.com/\S+/issues/\d+') | Select-Object -Last 1).Value
  if ($createdUrl) {
    $apiPath = Get-GitHubApiPath 'issue' $createdUrl
    $body = if ($apiPath) { (& $realGh api $apiPath --jq '.body // ""' 2>$null) | Out-String } else { $null }
    if ($LASTEXITCODE -ne 0) {
      $body = $null
    }
    $footer = if ($env:ORCA_GH_ISSUE_FOOTER) { $env:ORCA_GH_ISSUE_FOOTER } else { 'Made with [Orca](https://github.com/orca-ide) 🐋' }
    if ($null -ne $body -and $body -notmatch [Regex]::Escape($footer)) {
      $tmpFile = [System.IO.Path]::GetTempFileName()
      try {
        $trimmed = $body.TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n")
        if ([string]::IsNullOrWhiteSpace($trimmed)) {
          Set-Content -LiteralPath $tmpFile -Value $footer -NoNewline
        } else {
          Set-Content -LiteralPath $tmpFile -Value ($trimmed + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $footer) -NoNewline
        }
        # Why: gh has no transactional body append for newly-created issues.
        # This immediate REST patch keeps attribution scoped to the URL gh returned.
        try {
          & $realGh api -X PATCH $apiPath -f "body=$(Get-Content -LiteralPath $tmpFile -Raw)" | Out-Null
        } catch {
        }
      } finally {
        Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
exit 0
`
