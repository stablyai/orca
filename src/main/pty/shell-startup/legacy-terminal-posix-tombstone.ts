import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const SHELL_DOLLAR = '$'

// The shebang runs before PATH hygiene; env lookup could execute checkout-local bash.
const POSIX_INTERPRETER_CANDIDATES = [
  '/bin/bash',
  '/usr/bin/bash',
  '/usr/local/bin/bash',
  '/opt/homebrew/bin/bash'
] as const

function isExecutable(candidate: string): boolean {
  // Shebangs cannot quote whitespace in interpreter paths.
  if (/\s/.test(candidate)) {
    return false
  }
  try {
    // X_OK also accepts directories, which cannot serve as interpreters.
    if (!statSync(candidate).isFile()) {
      return false
    }
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Windows cannot verify guest interpreters; Git Bash and WSL both map /bin/bash.
const WINDOWS_POSIX_INTERPRETER = '/bin/bash'

/** Null when no absolute interpreter verifies; the caller must reuse a verified shebang or delete the wrapper. */
export function resolvePosixTombstoneInterpreter(
  pathValue: string | undefined = process.env.PATH,
  candidates: readonly string[] = POSIX_INTERPRETER_CANDIDATES,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform === 'win32') {
    return WINDOWS_POSIX_INTERPRETER
  }
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  // Support NixOS/Guix layouts without allowing empty/relative PATH entries to select checkout-local bash.
  for (const directory of pathValue?.split(':') ?? []) {
    if (!directory.startsWith('/')) {
      continue
    }
    const candidate = join(directory, 'bash')
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  return null
}

/** Reuse a verified absolute shebang to preserve shells with a hashed wrapper path; deletion would strand them at 127. */
export function readVerifiedShebangInterpreter(filePath: string): string | null {
  let firstLine: string
  try {
    firstLine = readFileSync(filePath, 'utf8').split('\n', 1)[0] ?? ''
  } catch {
    return null
  }
  const match = /^#!\s*(\S+)/.exec(firstLine)
  const interpreter = match?.[1]
  if (!interpreter?.startsWith('/')) {
    return null
  }
  // The body requires bash; env bash would reopen cwd-based interpreter lookup.
  if (basename(interpreter) !== 'bash') {
    return null
  }
  return isExecutable(interpreter) ? interpreter : null
}

const POSIX_TOMBSTONE = String.raw`#!__ORCA_INTERPRETER__
set -u

command_name="__ORCA_COMMAND__"
# Why this shape, rather than dirname: an unresolvable external would leave the substitution empty
# and cd into it succeeds, silently making wrapper_dir the cwd. With no slash the %/* strip yields the
# file name rather than a directory, so that case takes $PWD. CDPATH is cleared because cd searches
# it for a relative operand and echoes where it landed, which the substitution would capture.
# Each of these made self-exclusion miss the wrapper's own directory, so the lookup resolved back
# to this script.
wrapper_src="${SHELL_DOLLAR}{BASH_SOURCE[0]}"
case "$wrapper_src" in
  */*) wrapper_dir="$(CDPATH= cd -P -- "${SHELL_DOLLAR}{wrapper_src%/*}" 2>/dev/null && pwd)" ;;
  *) wrapper_dir="$PWD" ;;
esac
[[ -n "$wrapper_dir" ]] || wrapper_dir="$PWD"
legacy_wrapper_dir="${SHELL_DOLLAR}{ORCA_ATTRIBUTION_SHIM_DIR:-}"
cleaned_path="${SHELL_DOLLAR}{PATH:-}"

filter_path() {
  local legacy_target="$legacy_wrapper_dir"
  while [[ "$legacy_target" != "/" && "$legacy_target" == */ ]]; do
    legacy_target="${SHELL_DOLLAR}{legacy_target%/}"
  done
  local remaining="$cleaned_path"
  local filtered_path=""
  local separator=""
  path_entry_kept=0
  local entry normalized has_more
  while true; do
    if [[ "$remaining" == *:* ]]; then
      entry="${SHELL_DOLLAR}{remaining%%:*}"
      remaining="${SHELL_DOLLAR}{remaining#*:}"
      has_more=1
    else
      entry="$remaining"
      has_more=0
    fi
    normalized="$entry"
    while [[ "$normalized" != "/" && "$normalized" == */ ]]; do
      normalized="${SHELL_DOLLAR}{normalized%/}"
    done
    if [[ "$entry" != /* ]]; then
      # Why: an empty or relative PATH element resolves against the current directory, so keeping
      # it would let a repository-local git/gh win the lookup below.
      :
    elif [[ -n "$legacy_target" && "$normalized" == "$legacy_target" ]]; then
      :
    elif [[ "$legacy_target" == /* && "$entry" -ef "$legacy_target" ]]; then
      # Why -ef as well as the lexical test above: it compares filesystem identity, so it catches
      # the same directory reached through a symlink or a /legacy/../legacy spelling. It is false
      # when either path is gone, which is when the lexical test still holds, so neither alone is
      # enough.
      # Why only for an absolute target: bash resolves a relative -ef operand against the current
      # directory, so a relative ORCA_ATTRIBUTION_SHIM_DIR let the cwd decide which PATH entry
      # counted as the legacy directory and got a legitimate one skipped.
      :
    elif [[ "$entry" -ef "$wrapper_dir" ]]; then
      :
    else
      filtered_path+="$separator$entry"
      separator=":"
      path_entry_kept=1
    fi
    [[ "$has_more" == 1 ]] || break
  done
  cleaned_path="$filtered_path"
}

filter_path
unset ORCA_ENABLE_GIT_ATTRIBUTION ORCA_GIT_COMMIT_TRAILER ORCA_GH_PR_FOOTER
unset ORCA_GH_ISSUE_FOOTER ORCA_ATTRIBUTION_SHIM_DIR ORCA_REAL_GIT ORCA_REAL_GH ORCA_ATTRIBUTION_BYPASS

real_command=""
if [[ "$path_entry_kept" == 1 ]]; then
  real_command="$(PATH="$cleaned_path" type -P "$command_name" || true)"
fi
if [[ -n "$real_command" && "$real_command" -ef "${SHELL_DOLLAR}{BASH_SOURCE[0]}" ]]; then
  real_command=""
fi
if [[ -z "$real_command" ]]; then
  printf 'Orca compatibility wrapper could not locate %s on PATH.\n' "$command_name" >&2
  exit 127
fi
PATH="$cleaned_path" exec "$real_command" "$@"
`

export function renderLegacyTerminalPosixTombstone(
  command: 'git' | 'gh',
  interpreter: string = resolvePosixTombstoneInterpreter() ?? WINDOWS_POSIX_INTERPRETER
): string {
  return POSIX_TOMBSTONE.replaceAll('__ORCA_INTERPRETER__', interpreter).replaceAll(
    '__ORCA_COMMAND__',
    command
  )
}
