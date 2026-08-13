const SHELL_DOLLAR = '$'

const POSIX_TOMBSTONE = String.raw`#!/usr/bin/env bash
set -u

command_name="__ORCA_COMMAND__"
wrapper_dir="$(cd -- "$(dirname -- "${SHELL_DOLLAR}{BASH_SOURCE[0]}")" && pwd)"
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
    if [[ -n "$legacy_target" && "$normalized" == "$legacy_target" ]]; then
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

export function renderLegacyTerminalPosixTombstone(command: 'git' | 'gh'): string {
  return POSIX_TOMBSTONE.replaceAll('__ORCA_COMMAND__', command)
}
