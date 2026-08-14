import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

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

/** Returns null when no absolute interpreter can be verified; see the caller for what that means. */
export function resolvePosixTombstoneInterpreter(
  pathValue: string | undefined = process.env.PATH,
  // Why: injectable so the PATH-search branch below is reachable in tests on hosts that do have
  // a well-known bash.
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
  // Why: no absolute interpreter anywhere. Callers must delete the legacy wrapper rather than
  // write one with an ambient shebang, which would resolve bash from the cwd.
  return null
}

/**
 * Returns the absolute interpreter the wrapper being replaced already used, or null.
 *
 * Why: when this process cannot see an absolute bash, deleting the wrapper strands a shell that
 * has the path hashed -- it reports 127 rather than falling through to the next PATH entry. The
 * file about to be overwritten ran on this host, so its own shebang names an interpreter known to
 * work here, and reusing it keeps the compatibility promise without an ambient lookup.
 */
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
  // Why exactly bash: the body below uses BASH_SOURCE, [[, and local, so any other shell fails at
  // runtime -- a #!/bin/zsh wrapper was accepted and then exited 1 on `BASH_SOURCE[0]: parameter
  // not set`. This also rejects `#!/usr/bin/env bash`, which is absolute but defers the real
  // lookup to PATH, the current-directory exposure this whole path exists to avoid.
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
