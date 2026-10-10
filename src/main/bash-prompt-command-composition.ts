export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__orca_normalize_prompt_command_part() {
  local __orca_value="$1" __orca_output_name="$2" __orca_character __orca_chunk
  local __orca_value_length=\${#1} __orca_suffix_length=0 __orca_backslash_length=0
  local __orca_output_length __orca_scan_start
  while (( __orca_value_length - __orca_suffix_length >= 1024 )); do
    __orca_scan_start=$(( __orca_value_length - __orca_suffix_length - 1024 ))
    __orca_chunk="\${__orca_value:__orca_scan_start:1024}"
    case "$__orca_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __orca_suffix_length=$(( __orca_suffix_length + 1024 )) ;;
    esac
  done
  while (( __orca_suffix_length < __orca_value_length )); do
    __orca_character="\${__orca_value: -__orca_suffix_length - 1:1}"
    case "$__orca_character" in
      ' '|$'\\t'|$'\\n'|';') __orca_suffix_length=$(( __orca_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __orca_output_length=$(( \${#__orca_value} - __orca_suffix_length ))
  while (( __orca_output_length - __orca_backslash_length >= 1024 )); do
    __orca_scan_start=$(( __orca_output_length - __orca_backslash_length - 1024 ))
    __orca_chunk="\${__orca_value:__orca_scan_start:1024}"
    case "$__orca_chunk" in
      *[!\\\\]*) break ;;
      *) __orca_backslash_length=$(( __orca_backslash_length + 1024 )) ;;
    esac
  done
  while (( __orca_backslash_length < __orca_output_length )); do
    __orca_character="\${__orca_value:__orca_output_length - __orca_backslash_length - 1:1}"
    [[ "$__orca_character" == '\\' ]] || break
    __orca_backslash_length=$(( __orca_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __orca_suffix_length > 0 && __orca_backslash_length % 2 == 1 )); then
    __orca_suffix_length=$(( __orca_suffix_length - 1 ))
    __orca_backslash_length=0
  fi
  __orca_output_length=$(( \${#__orca_value} - __orca_suffix_length ))
  __orca_value="\${__orca_value:0:__orca_output_length}"
  # Bash 4.4-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __orca_suffix_length == 0 && ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __orca_backslash_length % 2 == 1 )); then
    __orca_value="$__orca_value\\\\"
  fi
  printf -v "$__orca_output_name" '%s' "$__orca_value"
}
__orca_restore_prompt_status() {
  return "$1"
}
__orca_update_user_debug_trap() {
  local __orca_debug_trap_spec="$1" __orca_unchanged_debug_trap_spec="$2"
  local __orca_debug_trap_command
  [[ "$__orca_debug_trap_spec" != "$__orca_unchanged_debug_trap_spec" ]] || return 0
  [[ "$__orca_debug_trap_spec" != "trap -- '__orca_osc133_preexec' DEBUG" ]] || return 0
  if [[ -z "$__orca_debug_trap_spec" ]]; then
    __orca_user_debug_trap=""
    unset __orca_chained_debug_trap
    return 0
  fi
  __orca_debug_trap_command="\${__orca_debug_trap_spec#trap -- }"
  __orca_debug_trap_command="\${__orca_debug_trap_command% DEBUG}"
  eval "__orca_user_debug_trap=$__orca_debug_trap_command"
  unset __orca_chained_debug_trap
}
__orca_run_user_debug_trap() {
  if [[ -n "\${__orca_user_debug_trap:-}" ]]; then
    eval "$__orca_user_debug_trap" || true
  fi
}
__orca_adopt_outer_debug_trap() {
  local __orca_debug_trap_spec="\${__orca_outer_debug_trap_spec:-}"
  unset __orca_outer_debug_trap_spec
  __orca_update_user_debug_trap "$__orca_debug_trap_spec" "trap -- '__orca_osc133_preexec' DEBUG"
}
__orca_run_prompt_command_array() {
  local __orca_exit_code="\${__orca_prompt_status:-$?}" __orca_prompt_part __orca_prompt_index __orca_user_count
  local __orca_suffix_part
  local __orca_final_prompt_command
  local __orca_in_prompt_dispatch=1 __orca_dispatching_user_prompt_command=""
  unset __orca_prompt_status
  __orca_adopt_outer_debug_trap
  trap '__orca_osc133_preexec' DEBUG
  for __orca_prompt_part in "\${__orca_prompt_command_prefix[@]+"\${__orca_prompt_command_prefix[@]}"}"; do
    if (( __orca_exit_code == 0 )); then
      eval "$__orca_prompt_part"
    else
      __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_prompt_part"
    fi
  done
  __orca_user_count=0
  for __orca_prompt_part in "\${__orca_prompt_command_array[@]+"\${__orca_prompt_command_array[@]}"}"; do
    __orca_user_count=$(( __orca_user_count + 1 ))
  done
  for (( __orca_prompt_index = 0; __orca_prompt_index + 1 < __orca_user_count; __orca_prompt_index++ )); do
    __orca_prompt_part="\${__orca_prompt_command_array[__orca_prompt_index]}"
    __orca_dispatching_user_prompt_command=1
    if (( __orca_exit_code == 0 )); then
      eval "$__orca_prompt_part"
    else
      __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_prompt_part"
    fi
    __orca_dispatching_user_prompt_command=""
  done
  if (( __orca_user_count > 0 )); then
    __orca_prompt_part="\${__orca_prompt_command_array[__orca_user_count - 1]}"
    # Why: keep the final user hook and Orca suffixes in one status-preserving eval.
    __orca_final_prompt_command='eval "$__orca_prompt_part"'
    for __orca_suffix_part in "\${__orca_prompt_command_suffix[@]+"\${__orca_prompt_command_suffix[@]}"}"; do
      __orca_final_prompt_command+=$'\\n'"$__orca_suffix_part"
    done
    __orca_dispatching_user_prompt_command=1
    if (( __orca_exit_code == 0 )); then
      eval "$__orca_final_prompt_command"
    else
      __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_final_prompt_command"
    fi
    __orca_dispatching_user_prompt_command=""
  else
    for __orca_prompt_part in "\${__orca_prompt_command_suffix[@]+"\${__orca_prompt_command_suffix[@]}"}"; do
      if (( __orca_exit_code == 0 )); then
        eval "$__orca_prompt_part"
      else
        __orca_restore_prompt_status "$__orca_exit_code" || eval "$__orca_prompt_part"
      fi
    done
  fi
  return "$__orca_exit_code"
}
__orca_finish_legacy_prompt_dispatch() {
  local __orca_suffix_part
  if [[ -n "\${__orca_in_prompt_command:-}" ]]; then
    for __orca_suffix_part in "\${__orca_prompt_command_suffix[@]+"\${__orca_prompt_command_suffix[@]}"}"; do
      eval "$__orca_suffix_part"
    done
  fi
  trap '__orca_osc133_preexec' DEBUG
  unset __orca_in_legacy_prompt_wrapper
}
__orca_normalize_prompt_command() {
  [[ -z "\${__orca_prompt_command_normalized:-}" ]] || return 0
  local __orca_prompt_part
  local -a __orca_normalized=()
  for __orca_prompt_part in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
    __orca_normalize_prompt_command_part "$__orca_prompt_part" __orca_prompt_part
    [[ -n "$__orca_prompt_part" ]] && __orca_normalized+=("$__orca_prompt_part")
  done
  __orca_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__orca_normalized[@]+"\${__orca_normalized[@]}"}")
  else
    __orca_prompt_command_array=("\${__orca_normalized[@]+"\${__orca_normalized[@]}"}")
    __orca_prompt_command_prefix=()
    __orca_prompt_command_suffix=()
    unset PROMPT_COMMAND
    # Why: PID scope distinguishes legacy prompt dispatch from ordinary user command text.
    __orca_prompt_status_variable="__orca_prompt_status_$$"
    __orca_prompt_status_capture_command="$__orca_prompt_status_variable=\\$?"
    __orca_prompt_status_value="\\\${$__orca_prompt_status_variable}"
    PROMPT_COMMAND="$__orca_prompt_status_capture_command; __orca_prompt_status=$__orca_prompt_status_value"'; __orca_prompt_had_functrace=""; if [[ -o functrace ]]; then __orca_prompt_had_functrace=1; set +T; fi; __orca_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__orca_prompt_had_functrace" ]] || set -T; unset __orca_prompt_had_functrace; __orca_run_prompt_command_array; __orca_finish_legacy_prompt_dispatch'
  fi
}
__orca_prepend_prompt_command() {
  local command="$1"
  __orca_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}")
  else
    __orca_prompt_command_prefix=("$command" "\${__orca_prompt_command_prefix[@]+"\${__orca_prompt_command_prefix[@]}"}")
  fi
}
__orca_append_prompt_command() {
  local command="$1"
  __orca_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __orca_prompt_command_suffix+=("$command")
  fi
}`
