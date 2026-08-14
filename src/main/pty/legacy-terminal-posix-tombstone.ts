import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'

const SHELL_DOLLAR = '$'

// Why: the shebang is the one command resolved before any of the script's own PATH hygiene runs.
// `env` uses execvp, so an empty or relative PATH element means the current directory and an
// untrusted checkout can supply the interpreter. Bake an absolute one when we can verify it.
const POSIX_INTERPRETER_CANDIDATES = [
  '/bin/bash',
  '/usr/bin/bash',
  '/usr/local/bin/bash',
  '/opt/homebrew/bin/bash'
] as const

function isExecutable(candidate: string): boolean {
  // Why: a shebang has no quoting, so a path with whitespace is unusable as an interpreter.
  if (/\s/.test(candidate)) {
    return false
  }
  try {
    // Why: X_OK alone is true for a directory named `bash`, which cannot be exec'd.
    if (!statSync(candidate).isFile()) {
      return false
    }
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Why: the POSIX tombstone is written on Windows too — Git Bash and WSL panes execute it — but
// none of the absolute candidates below exist to a Windows Electron process, and PATH there is
// `;`-separated, so the search cannot succeed either. Both MSYS and WSL map /bin/bash, so name it
// directly rather than falling through to an ambient lookup.
const WINDOWS_POSIX_INTERPRETER = '/bin/bash'

export function resolvePosixTombstoneInterpreter(
  pathValue: string | undefined = process.env.PATH,
  // Why: injectable so the PATH-search branch below is reachable in tests on hosts that do have
  // a well-known bash.
  candidates: readonly string[] = POSIX_INTERPRETER_CANDIDATES,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return WINDOWS_POSIX_INTERPRETER
  }
  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  // Why: distributions that put bash outside the well-known locations (NixOS, Guix) would
  // otherwise fall back to an ambient lookup. Search absolute PATH entries only — a relative or
  // empty one means the current directory, which is the exposure this whole function exists to
  // close.
  for (const directory of pathValue?.split(':') ?? []) {
    if (!directory.startsWith('/')) {
      continue
    }
    const candidate = join(directory, 'bash')
    if (isExecutable(candidate)) {
      return candidate
    }
  }
  // Why: last resort. Leaves the ambient lookup in place, but only when no absolute bash exists
  // anywhere, in which case the wrapper would not run at all otherwise.
  return '/usr/bin/env bash'
}

const POSIX_TOMBSTONE = String.raw`#!__ORCA_INTERPRETER__
set -u

command_name="__ORCA_COMMAND__"
# Why: parameter expansion, not the external dirname — if that were unresolvable the substitution
# would be empty and cd into it succeeds, silently making wrapper_dir the cwd so the wrapper
# fails to exclude itself from PATH.
wrapper_src="${SHELL_DOLLAR}{BASH_SOURCE[0]}"
case "$wrapper_src" in
  # Why: with no slash the %/* strip yields the file name, not a directory, so self-exclusion
  # would miss the wrapper's own dir and the lookup would resolve back to this script.
  */*) wrapper_dir="$(cd -- "${SHELL_DOLLAR}{wrapper_src%/*}" 2>/dev/null && pwd)" ;;
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
  local entry normalized candidate has_more
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
    candidate="${SHELL_DOLLAR}{entry:-.}"
    if [[ "$entry" != /* ]]; then
      # Why: an empty or relative PATH element resolves against the current directory, so keeping
      # it would let a repository-local git/gh win the lookup below.
      :
    elif [[ -n "$legacy_target" && "$normalized" == "$legacy_target" ]]; then
      :
    elif [[ "$candidate" -ef "$wrapper_dir" ]]; then
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
  interpreter = resolvePosixTombstoneInterpreter()
): string {
  return POSIX_TOMBSTONE.replaceAll('__ORCA_INTERPRETER__', interpreter).replaceAll(
    '__ORCA_COMMAND__',
    command
  )
}
