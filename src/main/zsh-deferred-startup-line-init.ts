// Why: stock zshrc can replace line-init after the user clears the prompt-hook array.
export const ZSH_DEFERRED_LINE_INIT_BLOCK = `__orca_deferred_line_init() {
  builtin emulate -L zsh
  (( \${+functions[__orca_deferred_init]} )) || return 0
  local __orca_direct_line_init=0
  [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]] && __orca_direct_line_init=1
  __orca_deferred_init
  if (( __orca_direct_line_init && \${+widgets[zle-line-init]} )); then
    zle zle-line-init "$@"
  elif [[ "\${widgets[zle-line-init]:-}" == user:__orca_prompt_mark ]]; then
    local __orca_prev_line_init_fn=""
    __orca_prompt_mark "$@"
  fi
}
# Why: scheduled callbacks run after user prompt hooks without copying their function metadata.
__orca_deferred_sched_init() {
  local __orca_prompt_status=$?
  builtin emulate -L zsh
  (( \${+functions[__orca_deferred_init]} )) && __orca_deferred_init
  builtin unset __orca_deferred_sched_armed
  builtin unfunction __orca_deferred_sched_init
  return $__orca_prompt_status
}
__orca_arm_deferred_line_init() {
  builtin emulate -L zsh
  if [[ "\${widgets[zle-line-init]:-}" != user:__orca_deferred_line_init ]]; then
    if (( \${+widgets[zle-line-init]} )); then
      zle -A zle-line-init __orca_saved_line_init
    fi
    zle -N zle-line-init __orca_deferred_line_init
  fi
  if (( ! $+__orca_deferred_sched_armed )) && builtin zmodload -F zsh/sched b:sched 2>/dev/null; then
    builtin sched +0 __orca_deferred_sched_init && builtin typeset -g __orca_deferred_sched_armed=1
  fi
}`

// Why: restore the exact prior widget before the existing readiness hook captures it.
export const ZSH_DEFERRED_LINE_INIT_RETIRE_BLOCK = `  if (( \${+widgets[__orca_saved_line_init]} )); then
    if [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]]; then
      zle -A __orca_saved_line_init zle-line-init
    fi
    zle -D __orca_saved_line_init
  elif [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]]; then
    zle -D zle-line-init
  fi`

// Why: add-zle-hook-widget can keep an alias of the bootstrap in its own chain.
export const ZSH_DEFERRED_LINE_INIT_CLEANUP_BLOCK = `  (( $+__orca_deferred_sched_armed )) || builtin unfunction __orca_deferred_sched_init
  local __orca_widget __orca_line_init_bound=0
  for __orca_widget in "\${(v)widgets[@]}"; do
    if [[ "$__orca_widget" == user:__orca_deferred_line_init ]]; then
      __orca_line_init_bound=1
      break
    fi
  done
  (( __orca_line_init_bound )) || builtin unfunction __orca_deferred_line_init`
