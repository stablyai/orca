export const SHELL_COMMAND_NONCE_ENV = 'ORCA_SHELL_COMMAND_NONCE'
export const SHELL_INTEGRATION_CONTEXT_ENV = 'ORCA_SHELL_INTEGRATION_CONTEXT'
export const SHELL_INTEGRATION_DIRECT_CONTEXT = 'direct'
export const SHELL_COMMAND_MAX_CHARS = 4096

export const BASH_COMMAND_MARKER_CAPTURE_BLOCK = `_orca_shell_command_nonce="\${${SHELL_COMMAND_NONCE_ENV}:-}"
_orca_shell_integration_context="\${${SHELL_INTEGRATION_CONTEXT_ENV}:-}"
builtin unset ${SHELL_COMMAND_NONCE_ENV} ${SHELL_INTEGRATION_CONTEXT_ENV}
__orca_command_markers_allowed() {
  [[ -n "$_orca_shell_command_nonce" ]] || return 1
  [[ "$_orca_shell_integration_context" == "${SHELL_INTEGRATION_DIRECT_CONTEXT}" ]] && return 0
  [[ -z "\${TMUX:-}\${STY:-}" ]] || return 1
  case "\${TERM:-}" in tmux*|screen*) return 1 ;; esac
  return 0
}`

export const ZSH_COMMAND_MARKER_CAPTURE_BLOCK = `builtin typeset -g _orca_shell_command_nonce="\${${SHELL_COMMAND_NONCE_ENV}:-}"
builtin typeset -g _orca_shell_integration_context="\${${SHELL_INTEGRATION_CONTEXT_ENV}:-}"
builtin unset ${SHELL_COMMAND_NONCE_ENV} ${SHELL_INTEGRATION_CONTEXT_ENV}
__orca_command_markers_allowed() {
  [[ -n "$_orca_shell_command_nonce" ]] || return 1
  [[ "$_orca_shell_integration_context" == "${SHELL_INTEGRATION_DIRECT_CONTEXT}" ]] && return 0
  [[ -z "\${TMUX:-}\${STY:-}" ]] || return 1
  case "\${TERM:-}" in tmux*|screen*) return 1 ;; esac
  return 0
}`

export const BASH_COMMAND_MARKER_EMIT_BLOCK = `if __orca_command_markers_allowed && command -v base64 >/dev/null 2>&1; then
    local _orca_command_text="\${BASH_COMMAND:0:${SHELL_COMMAND_MAX_CHARS}}"
    local _orca_command_b64
    _orca_command_b64="$(builtin printf %s "$_orca_command_text" | command base64 | command tr -d '\\r\\n')"
    builtin printf "\\033]777;orca-cmd;%s;%s\\007" "$_orca_shell_command_nonce" "$_orca_command_b64"
  fi`

export const ZSH_COMMAND_MARKER_EMIT_BLOCK = `if __orca_command_markers_allowed && (( $+commands[base64] )); then
    local _orca_command_text="\${1[1,${SHELL_COMMAND_MAX_CHARS}]}"
    local _orca_command_b64="$(builtin printf %s "$_orca_command_text" | command base64 | command tr -d '\\r\\n')"
    builtin printf "\\033]777;orca-cmd;%s;%s\\007" "$_orca_shell_command_nonce" "$_orca_command_b64"
  fi`

export function getFishCommandMarkerInitCommand(): string {
  // Why -g and not -l: the launcher runs this through `fish -C`, whose top-level
  // scope the event handler happens to reach; -g states the requirement instead of
  // depending on that.
  return `set -g __orca_shell_command_nonce "$${SHELL_COMMAND_NONCE_ENV}"
set -g __orca_shell_integration_context "$${SHELL_INTEGRATION_CONTEXT_ENV}"
set -e ${SHELL_COMMAND_NONCE_ENV} ${SHELL_INTEGRATION_CONTEXT_ENV}
function __orca_command_markers_allowed --no-scope-shadowing
  test -n "$__orca_shell_command_nonce"; or return 1
  if test "$__orca_shell_integration_context" = "${SHELL_INTEGRATION_DIRECT_CONTEXT}"
    return 0
  end
  if set -q TMUX; or set -q STY
    return 1
  end
  string match -qr '^(tmux|screen)' -- "$TERM"; and return 1
  return 0
end
function __orca_command_marker --on-event fish_preexec --no-scope-shadowing
  __orca_command_markers_allowed; or return
  type -q base64; or return
  set -l __orca_command_text (string sub -l ${SHELL_COMMAND_MAX_CHARS} -- "$argv[1]")
  set -l __orca_command_b64 (builtin printf %s "$__orca_command_text" | command base64 | command tr -d '\\r\\n')
  builtin printf '\\e]777;orca-cmd;%s;%s\\a' "$__orca_shell_command_nonce" "$__orca_command_b64"
  builtin printf '\\e]133;C\\a'
end
function __orca_command_finished --on-event fish_postexec --no-scope-shadowing
  # Why captured first: every later command overwrites $status before it is read.
  set -l __orca_exit_status $status
  __orca_command_markers_allowed; or return
  # Why the same base64 gate as fish_preexec, which the exit status does not need:
  # it is the only condition that can stop preexec emitting 133;C, and a D with no
  # C retires a pane's live identity with nothing left to invalidate it.
  type -q base64; or return
  builtin printf '\\e]133;D;%s\\a' "$__orca_exit_status"
end`
}

export function shellCommandMarkerEnv(nonce: string | null): Record<string, string> {
  return {
    [SHELL_INTEGRATION_CONTEXT_ENV]: SHELL_INTEGRATION_DIRECT_CONTEXT,
    ...(nonce === null ? {} : { [SHELL_COMMAND_NONCE_ENV]: nonce })
  }
}
