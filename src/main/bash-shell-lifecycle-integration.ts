/** Private per-launch signals; consume the binding before user profiles or children. */
export const BASH_SHELL_LIFECYCLE_INIT = `__orca_lifecycle_init_xtrace=""
case $- in *x*) __orca_lifecycle_init_xtrace=1; set +x ;; esac
__orca_lifecycle_binding="\${_ORCA_SHELL_LIFECYCLE_BINDING:-}"
__orca_lifecycle_state="\${_ORCA_SHELL_LIFECYCLE_STATE:-}"
unset _ORCA_SHELL_LIFECYCLE_BINDING _ORCA_SHELL_LIFECYCLE_STATE
__orca_lifecycle_sequence=0
__orca_lifecycle_shell=$$
builtin export -n __orca_lifecycle_binding __orca_lifecycle_state __orca_lifecycle_sequence __orca_lifecycle_shell
[[ -z "$__orca_lifecycle_init_xtrace" ]] || set -x
unset __orca_lifecycle_init_xtrace
`

export const BASH_SHELL_LIFECYCLE_EMITTER = `__orca_osc133_observe() {
  local __orca_lifecycle_had_xtrace=""
  case $- in *x*) __orca_lifecycle_had_xtrace=1; set +x ;; esac
  if [[ -n "$__orca_lifecycle_binding" && "$$" == "$__orca_lifecycle_shell" && "\${BASH_SUBSHELL:-0}" == 0 ]]; then
    local __orca_lifecycle_phase="$1"
    [[ ! -o functrace ]] || __orca_lifecycle_phase=unknown
    __orca_lifecycle_sequence=$((__orca_lifecycle_sequence + 1))
    if [[ -z "$__orca_lifecycle_state" ]] || ! builtin printf '%s;%s;%s\\n' "$__orca_lifecycle_binding" "$__orca_lifecycle_sequence" "$__orca_lifecycle_phase" 2>/dev/null >| "$__orca_lifecycle_state"; then
      __orca_lifecycle_phase=unknown
    fi
    builtin printf '\\033]777;orca-shell-lifecycle;%s;%s;%s\\007' "$__orca_lifecycle_binding" "$__orca_lifecycle_sequence" "$__orca_lifecycle_phase"
  fi
  [[ -z "$__orca_lifecycle_had_xtrace" ]] || set -x
}
`
