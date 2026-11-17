/** Nonexported state belongs to this interactive shell, never a forked/nested shell. */
export const POSIX_COMMAND_IDENTITY_BLOCK = `unset __orca_command_id __orca_command_owner
typeset +x __orca_command_owner=$$
__orca_osc133_command_is_owner() {
  [[ "\${__orca_command_owner:-}" == "$$" && "\${BASH_SUBSHELL:-0}" == 0 && "\${ZSH_SUBSHELL:-0}" == 0 ]]
}
__orca_osc133_bind_command() {
  __orca_osc133_command_is_owner || return 0
  if [[ -n "\${ZSH_VERSION:-}" ]]; then
    builtin typeset -g +x __orca_command_id="$1" __orca_in_command=1
  else
    __orca_command_id=$1
    __orca_in_command=1
    export -n __orca_command_id __orca_in_command
  fi
  builtin printf '\\033]133;C;orca_command=%s\\007' "$__orca_command_id"
}
__orca_osc133_emit_command_finished() {
  local __orca_status=$1 __orca_id=""
  if __orca_osc133_command_is_owner; then
    __orca_id="\${__orca_command_id:-}"
    unset __orca_command_id __orca_in_command
  fi
  if [[ -n "$__orca_id" ]]; then
    builtin printf '\\033]133;D;%s;orca_command=%s\\007' "$__orca_status" "$__orca_id"
  else
    builtin printf '\\033]133;D;%s\\007' "$__orca_status"
  fi
}`
