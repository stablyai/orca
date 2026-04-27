/* eslint-disable max-lines -- Why: this module owns the generated git/gh wrapper
scripts for both POSIX shells and Windows shells. Keeping the scripts adjacent
to the env injection code makes the attribution behavior auditable as one unit
instead of scattering generated shell fragments across files. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const ATTRIBUTION_ROOT_DIR = 'orca-terminal-attribution'
const ATTRIBUTION_SHIM_VERSION = '6'
const ORCA_PRODUCT_URL = 'https://github.com/stablyai/orca'
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
): void {
  if (!options.enabled) {
    return
  }

  let shimPaths: AttributionShimPaths
  try {
    shimPaths = ensureAttributionShims(options.userDataPath)
  } catch {
    return
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
  const prependDirKeys = new Set(
    prependDirs.map((dir) => (process.platform === 'win32' ? dir.toLowerCase() : dir))
  )
  const cleanedBasePath = basePath
    .split(pathDelimiter)
    .filter((entry) => {
      if (!entry) {
        return false
      }
      const key = process.platform === 'win32' ? entry.toLowerCase() : entry
      return !prependDirKeys.has(key)
    })
    .join(pathDelimiter)

  // Why: these wrappers should affect only Orca-managed PTYs. Prepending the
  // shim directory here keeps the attribution behavior scoped to Orca's live
  // terminal environment instead of mutating global git/gh config or the
  // user's external shell PATH.
  baseEnv.PATH = [...prependDirs, cleanedBasePath].filter(Boolean).join(pathDelimiter)
  baseEnv.ORCA_ENABLE_GIT_ATTRIBUTION = '1'
  baseEnv.ORCA_GIT_COMMIT_TRAILER = ORCA_GIT_COMMIT_TRAILER
  baseEnv.ORCA_GH_PR_FOOTER = ORCA_GH_FOOTER
  baseEnv.ORCA_GH_ISSUE_FOOTER = ORCA_GH_FOOTER
  baseEnv.ORCA_ATTRIBUTION_SHIM_DIR = posixDir

  if (process.platform === 'win32') {
    if (resolvedGit) {
      baseEnv.ORCA_REAL_GIT = resolvedGit
    }
    if (resolvedGh) {
      baseEnv.ORCA_REAL_GH = resolvedGh
    }
  }
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

is_commit_command() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -c|--config|-C|--git-dir|--work-tree|--namespace)
        shift 2
        ;;
      --config=*|--git-dir=*|--work-tree=*|--namespace=*)
        shift
        ;;
      commit)
        return 0
        ;;
      -*)
        shift
        ;;
      *)
        return 1
        ;;
    esac
  done
  return 1
}

if [[ "\${ORCA_ENABLE_GIT_ATTRIBUTION:-0}" != "1" || "\${ORCA_ATTRIBUTION_BYPASS:-0}" == "1" ]] || ! is_commit_command "$@"; then
  PATH="$real_path" exec "$real_git" "$@"
fi

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      PATH="$real_path" exec "$real_git" "$@"
      ;;
  esac
done

trailer="\${ORCA_GIT_COMMIT_TRAILER:-Co-authored-by: Orca <help@stably.ai>}"

has_explicit_commit_message() {
  local arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      -m|--message|-F|--file)
        return 0
        ;;
      --message=*|--file=*|-[!-]*m|-m?*|-F?*)
        return 0
        ;;
    esac
    shift
  done
  return 1
}

has_unsupported_commit_message_source() {
  local arg next_arg
  local saw_commit=0
  while [[ $# -gt 0 ]]; do
    arg="$1"
    if [[ $saw_commit -eq 0 ]]; then
      case "$arg" in
        -c|--config|-C|--git-dir|--work-tree|--namespace)
          shift 2
          continue
          ;;
        --config=*|--git-dir=*|--work-tree=*|--namespace=*)
          shift
          continue
          ;;
        commit)
          saw_commit=1
          shift
          continue
          ;;
      esac
    fi
    case "$arg" in
      -C|--reuse-message|-c|--reedit-message|--fixup|--squash)
        return 0
        ;;
      -F|--file)
        shift
        next_arg="${SHELL_DOLLAR}{1:-}"
        [[ -z "$next_arg" || ! -f "$next_arg" ]] && return 0
        ;;
      --file=*)
        next_arg="${SHELL_DOLLAR}{arg#--file=}"
        [[ ! -f "$next_arg" ]] && return 0
        ;;
      -F?*)
        next_arg="${SHELL_DOLLAR}{arg:2}"
        [[ ! -f "$next_arg" ]] && return 0
        ;;
    esac
    shift
  done
  return 1
}

message_already_has_trailer() {
  local arg next_arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      -m|--message)
        shift
        next_arg="${SHELL_DOLLAR}{1:-}"
        grep -Fqi "$trailer" <<<"$next_arg" && return 0
        ;;
      --message=*)
        grep -Fqi "$trailer" <<<"${SHELL_DOLLAR}{arg#--message=}" && return 0
        ;;
      -m?*)
        grep -Fqi "$trailer" <<<"${SHELL_DOLLAR}{arg:2}" && return 0
        ;;
      -[!-]*m)
        shift
        next_arg="${SHELL_DOLLAR}{1:-}"
        grep -Fqi "$trailer" <<<"$next_arg" && return 0
        ;;
      -F|--file)
        shift
        next_arg="${SHELL_DOLLAR}{1:-}"
        [[ -n "$next_arg" && -f "$next_arg" ]] && grep -Fqi "$trailer" "$next_arg" && return 0
        ;;
      --file=*)
        next_arg="${SHELL_DOLLAR}{arg#--file=}"
        [[ -f "$next_arg" ]] && grep -Fqi "$trailer" "$next_arg" && return 0
        ;;
      -F?*)
        next_arg="${SHELL_DOLLAR}{arg:2}"
        [[ -f "$next_arg" ]] && grep -Fqi "$trailer" "$next_arg" && return 0
        ;;
    esac
    shift
  done
  return 1
}

if ! has_explicit_commit_message "$@" || has_unsupported_commit_message_source "$@" || message_already_has_trailer "$@"; then
  PATH="$real_path" exec "$real_git" "$@"
fi

tmp_file=""
cleanup_commit_message() {
  if [[ -n "$tmp_file" ]]; then
    rm -f "$tmp_file"
  fi
}
trap cleanup_commit_message EXIT

attributed_args=()
replaced_file_message=0
while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    -F|--file)
      if [[ $replaced_file_message -eq 0 ]]; then
        shift
        source_file="${SHELL_DOLLAR}{1:-}"
        tmp_file="$(mktemp)"
        if [[ -n "$source_file" && -f "$source_file" ]]; then
          printf '%s\n\n%s\n' "$(cat "$source_file")" "$trailer" >"$tmp_file"
          attributed_args+=("$arg" "$tmp_file")
          replaced_file_message=1
        else
          attributed_args+=("$arg" "$source_file")
        fi
      else
        attributed_args+=("$arg")
      fi
      ;;
    --file=*)
      if [[ $replaced_file_message -eq 0 ]]; then
        source_file="${SHELL_DOLLAR}{arg#--file=}"
        tmp_file="$(mktemp)"
        if [[ -f "$source_file" ]]; then
          printf '%s\n\n%s\n' "$(cat "$source_file")" "$trailer" >"$tmp_file"
          attributed_args+=("--file=$tmp_file")
          replaced_file_message=1
        else
          attributed_args+=("$arg")
        fi
      else
        attributed_args+=("$arg")
      fi
      ;;
    -F?*)
      if [[ $replaced_file_message -eq 0 ]]; then
        source_file="${SHELL_DOLLAR}{arg:2}"
        tmp_file="$(mktemp)"
        if [[ -f "$source_file" ]]; then
          printf '%s\n\n%s\n' "$(cat "$source_file")" "$trailer" >"$tmp_file"
          attributed_args+=("-F$tmp_file")
          replaced_file_message=1
        else
          attributed_args+=("$arg")
        fi
      else
        attributed_args+=("$arg")
      fi
      ;;
    *)
      attributed_args+=("$arg")
      ;;
  esac
  shift
done

if [[ $replaced_file_message -eq 0 ]]; then
  attributed_args+=("-m" "$trailer")
fi

# Why: commit-msg hooks and commit signing must see the final message. Only
# commands that already provide a noninteractive message get attribution; editor
# based commits pass through unchanged instead of being amended after success.
ORCA_ATTRIBUTION_BYPASS=1 PATH="$real_path" exec "$real_git" "${SHELL_DOLLAR}{attributed_args[@]}"
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
  PATH="$real_path" "$real_gh" api -X PATCH "$api_path" -F "body=@$tmp_file" >/dev/null || true
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
  footer="\${ORCA_GH_PR_FOOTER:-Made with [Orca](https://github.com/stablyai/orca) 🐋}"
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
  footer="\${ORCA_GH_ISSUE_FOOTER:-Made with [Orca](https://github.com/stablyai/orca) 🐋}"
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
call :orca_is_git_commit %*
if errorlevel 1 goto run
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

:orca_is_git_commit
if "%~1"=="" exit /b 1
if /I "%~1"=="commit" exit /b 0
set "orca_git_arg=%~1"
if /I "%orca_git_arg%"=="-c" goto skip_two
if /I "%orca_git_arg%"=="--config" goto skip_two
if /I "%orca_git_arg%"=="-C" goto skip_two
if /I "%orca_git_arg%"=="--git-dir" goto skip_two
if /I "%orca_git_arg%"=="--work-tree" goto skip_two
if /I "%orca_git_arg%"=="--namespace" goto skip_two
if /I "%orca_git_arg:~0,9%"=="--config=" goto skip_one
if /I "%orca_git_arg:~0,10%"=="--git-dir=" goto skip_one
if /I "%orca_git_arg:~0,12%"=="--work-tree=" goto skip_one
if /I "%orca_git_arg:~0,12%"=="--namespace=" goto skip_one
if "%orca_git_arg:~0,1%"=="-" goto skip_one
exit /b 1
:skip_two
shift
shift
goto orca_is_git_commit
:skip_one
shift
goto orca_is_git_commit
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

function Test-GitCommitCommand {
  param([string[]]$CommandArgs)
  for ($i = 0; $i -lt $CommandArgs.Count; $i++) {
    $arg = $CommandArgs[$i]
    if ($arg -eq '-c' -or $arg -eq '--config' -or $arg -eq '-C' -or $arg -eq '--git-dir' -or $arg -eq '--work-tree' -or $arg -eq '--namespace') {
      $i++
      continue
    }
    if ($arg.StartsWith('--config=') -or $arg.StartsWith('--git-dir=') -or $arg.StartsWith('--work-tree=') -or $arg.StartsWith('--namespace=')) {
      continue
    }
    if ($arg -eq 'commit') {
      return $true
    }
    if ($arg.StartsWith('-')) {
      continue
    }
    return $false
  }
  return $false
}

function Test-ExplicitCommitMessage {
  param([string[]]$CommandArgs)
  foreach ($arg in $CommandArgs) {
    if ($arg -eq '-m' -or $arg -eq '--message' -or $arg -eq '-F' -or $arg -eq '--file' -or $arg.StartsWith('--message=') -or $arg.StartsWith('--file=') -or ($arg.StartsWith('-m') -and $arg.Length -gt 2) -or ($arg.StartsWith('-F') -and $arg.Length -gt 2) -or ($arg.StartsWith('-') -and -not $arg.StartsWith('--') -and $arg.EndsWith('m'))) {
      return $true
    }
  }
  return $false
}

function Test-UnsupportedCommitMessageSource {
  param([string[]]$CommandArgs)
  $sawCommit = $false
  for ($i = 0; $i -lt $CommandArgs.Count; $i++) {
    $arg = $CommandArgs[$i]
    if (-not $sawCommit) {
      if ($arg -eq '-c' -or $arg -eq '--config' -or $arg -eq '-C' -or $arg -eq '--git-dir' -or $arg -eq '--work-tree' -or $arg -eq '--namespace') {
        $i++
        continue
      }
      if ($arg.StartsWith('--config=') -or $arg.StartsWith('--git-dir=') -or $arg.StartsWith('--work-tree=') -or $arg.StartsWith('--namespace=')) {
        continue
      }
      if ($arg -eq 'commit') {
        $sawCommit = $true
        continue
      }
    }
    if ($arg -eq '-C' -or $arg -eq '--reuse-message' -or $arg -eq '-c' -or $arg -eq '--reedit-message' -or $arg -eq '--fixup' -or $arg -eq '--squash') {
      return $true
    }
    if ($arg -eq '-F' -or $arg -eq '--file') {
      $i++
      if ($i -ge $CommandArgs.Count -or -not (Test-Path -LiteralPath $CommandArgs[$i])) {
        return $true
      }
      continue
    }
    if ($arg.StartsWith('--file=')) {
      if (-not (Test-Path -LiteralPath $arg.Substring('--file='.Length))) {
        return $true
      }
      continue
    }
    if ($arg.StartsWith('-F') -and $arg.Length -gt 2) {
      if (-not (Test-Path -LiteralPath $arg.Substring(2))) {
        return $true
      }
      continue
    }
  }
  return $false
}

function Test-CommitMessageHasTrailer {
  param([string[]]$CommandArgs)
  for ($i = 0; $i -lt $CommandArgs.Count; $i++) {
    $arg = $CommandArgs[$i]
    if ($arg -eq '-m' -or $arg -eq '--message') {
      $i++
      if ($i -lt $CommandArgs.Count -and $CommandArgs[$i] -match [Regex]::Escape($trailer)) {
        return $true
      }
    } elseif ($arg.StartsWith('--message=')) {
      if ($arg.Substring('--message='.Length) -match [Regex]::Escape($trailer)) {
        return $true
      }
    } elseif ($arg.StartsWith('-m') -and $arg.Length -gt 2) {
      if ($arg.Substring(2) -match [Regex]::Escape($trailer)) {
        return $true
      }
    } elseif ($arg.StartsWith('-') -and -not $arg.StartsWith('--') -and $arg.EndsWith('m')) {
      $i++
      if ($i -lt $CommandArgs.Count -and $CommandArgs[$i] -match [Regex]::Escape($trailer)) {
        return $true
      }
    } elseif ($arg -eq '-F' -or $arg -eq '--file') {
      $i++
      if ($i -lt $CommandArgs.Count -and (Test-Path -LiteralPath $CommandArgs[$i]) -and (Get-Content -LiteralPath $CommandArgs[$i] -Raw) -match [Regex]::Escape($trailer)) {
        return $true
      }
    } elseif ($arg.StartsWith('--file=')) {
      $path = $arg.Substring('--file='.Length)
      if ((Test-Path -LiteralPath $path) -and (Get-Content -LiteralPath $path -Raw) -match [Regex]::Escape($trailer)) {
        return $true
      }
    } elseif ($arg.StartsWith('-F') -and $arg.Length -gt 2) {
      $path = $arg.Substring(2)
      if ((Test-Path -LiteralPath $path) -and (Get-Content -LiteralPath $path -Raw) -match [Regex]::Escape($trailer)) {
        return $true
      }
    }
  }
  return $false
}

if (-not (Test-GitCommitCommand $args) -or -not (Test-ExplicitCommitMessage $args) -or (Test-UnsupportedCommitMessageSource $args) -or (Test-CommitMessageHasTrailer $args)) {
  & $realGit @args
  exit $LASTEXITCODE
}

$tmpFile = $null
$attributedArgs = New-Object System.Collections.Generic.List[string]
$replacedFileMessage = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  $arg = $args[$i]
  if (($arg -eq '-F' -or $arg -eq '--file') -and -not $replacedFileMessage) {
    $i++
    $sourceFile = if ($i -lt $args.Count) { $args[$i] } else { '' }
    if ($sourceFile -and (Test-Path -LiteralPath $sourceFile)) {
      $tmpFile = [System.IO.Path]::GetTempFileName()
      Set-Content -LiteralPath $tmpFile -Value ((Get-Content -LiteralPath $sourceFile -Raw).TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n") + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $trailer) -NoNewline
      $attributedArgs.Add($arg)
      $attributedArgs.Add($tmpFile)
      $replacedFileMessage = $true
    } else {
      $attributedArgs.Add($arg)
      $attributedArgs.Add($sourceFile)
    }
  } elseif ($arg.StartsWith('--file=') -and -not $replacedFileMessage) {
    $sourceFile = $arg.Substring('--file='.Length)
    if (Test-Path -LiteralPath $sourceFile) {
      $tmpFile = [System.IO.Path]::GetTempFileName()
      Set-Content -LiteralPath $tmpFile -Value ((Get-Content -LiteralPath $sourceFile -Raw).TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n") + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $trailer) -NoNewline
      $attributedArgs.Add("--file=$tmpFile")
      $replacedFileMessage = $true
    } else {
      $attributedArgs.Add($arg)
    }
  } elseif ($arg.StartsWith('-F') -and $arg.Length -gt 2 -and -not $replacedFileMessage) {
    $sourceFile = $arg.Substring(2)
    if (Test-Path -LiteralPath $sourceFile) {
      $tmpFile = [System.IO.Path]::GetTempFileName()
      Set-Content -LiteralPath $tmpFile -Value ((Get-Content -LiteralPath $sourceFile -Raw).TrimEnd("${POWERSHELL_TICK}r", "${POWERSHELL_TICK}n") + "${POWERSHELL_TICK}r${POWERSHELL_TICK}n${POWERSHELL_TICK}r${POWERSHELL_TICK}n" + $trailer) -NoNewline
      $attributedArgs.Add("-F$tmpFile")
      $replacedFileMessage = $true
    } else {
      $attributedArgs.Add($arg)
    }
  } else {
    $attributedArgs.Add($arg)
  }
}

if (-not $replacedFileMessage) {
  $attributedArgs.Add('-m')
  $attributedArgs.Add($trailer)
}

# Why: commit-msg hooks and signing should validate the final message. Editor
# commits pass through unchanged rather than being amended after success.
$env:ORCA_ATTRIBUTION_BYPASS = '1'
try {
  $attributedArgArray = $attributedArgs.ToArray()
  & $realGit @attributedArgArray
  exit $LASTEXITCODE
} finally {
  if ($tmpFile) {
    Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
  }
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

function Test-CreateCommand {
  param([string[]]$CommandArgs, [string]$Kind)
  return $CommandArgs.Count -ge 2 -and $CommandArgs[0].ToLowerInvariant() -eq $Kind -and $CommandArgs[1].ToLowerInvariant() -eq 'create'
}

$isPrCreate = Test-CreateCommand $args 'pr'
$isIssueCreate = Test-CreateCommand $args 'issue'
if (($isPrCreate -or $isIssueCreate) -and (Test-PassthroughCreateArgs $args)) {
  & $realGh @args
  exit $LASTEXITCODE
}

if (($isPrCreate -or $isIssueCreate) -and -not (Test-NonInteractiveCreateArgs $args)) {
  & $realGh @args
  $status = $LASTEXITCODE
  if ($status -ne 0) {
    exit $status
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

if ($isPrCreate) {
  $createdUrl = ([regex]::Matches(($stdoutCapture + [Environment]::NewLine + $stderrCapture), 'https://github.com/\S+/pull/\d+') | Select-Object -Last 1).Value
  if ($createdUrl) {
    $apiPath = Get-GitHubApiPath 'pr' $createdUrl
    $body = if ($apiPath) { (& $realGh api $apiPath --jq '.body // ""' 2>$null) | Out-String } else { $null }
    if ($LASTEXITCODE -ne 0) {
      $body = $null
    }
    $footer = if ($env:ORCA_GH_PR_FOOTER) { $env:ORCA_GH_PR_FOOTER } else { 'Made with [Orca](https://github.com/stablyai/orca) 🐋' }
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
          & $realGh api -X PATCH $apiPath -F "body=@$tmpFile" | Out-Null
        } catch {
        }
      } finally {
        Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

if ($isIssueCreate) {
  $createdUrl = ([regex]::Matches(($stdoutCapture + [Environment]::NewLine + $stderrCapture), 'https://github.com/\S+/issues/\d+') | Select-Object -Last 1).Value
  if ($createdUrl) {
    $apiPath = Get-GitHubApiPath 'issue' $createdUrl
    $body = if ($apiPath) { (& $realGh api $apiPath --jq '.body // ""' 2>$null) | Out-String } else { $null }
    if ($LASTEXITCODE -ne 0) {
      $body = $null
    }
    $footer = if ($env:ORCA_GH_ISSUE_FOOTER) { $env:ORCA_GH_ISSUE_FOOTER } else { 'Made with [Orca](https://github.com/stablyai/orca) 🐋' }
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
          & $realGh api -X PATCH $apiPath -F "body=@$tmpFile" | Out-Null
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
