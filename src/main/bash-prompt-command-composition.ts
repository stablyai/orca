export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__mcode_normalize_prompt_command_part() {
  local __mcode_value="$1" __mcode_output_name="$2" __mcode_character __mcode_chunk
  local __mcode_value_length=\${#1} __mcode_suffix_length=0 __mcode_backslash_length=0
  local __mcode_output_length __mcode_scan_start
  while (( __mcode_value_length - __mcode_suffix_length >= 1024 )); do
    __mcode_scan_start=$(( __mcode_value_length - __mcode_suffix_length - 1024 ))
    __mcode_chunk="\${__mcode_value:__mcode_scan_start:1024}"
    case "$__mcode_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __mcode_suffix_length=$(( __mcode_suffix_length + 1024 )) ;;
    esac
  done
  while (( __mcode_suffix_length < __mcode_value_length )); do
    __mcode_character="\${__mcode_value: -__mcode_suffix_length - 1:1}"
    case "$__mcode_character" in
      ' '|$'\\t'|$'\\n'|';') __mcode_suffix_length=$(( __mcode_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __mcode_output_length=$(( \${#__mcode_value} - __mcode_suffix_length ))
  while (( __mcode_output_length - __mcode_backslash_length >= 1024 )); do
    __mcode_scan_start=$(( __mcode_output_length - __mcode_backslash_length - 1024 ))
    __mcode_chunk="\${__mcode_value:__mcode_scan_start:1024}"
    case "$__mcode_chunk" in
      *[!\\\\]*) break ;;
      *) __mcode_backslash_length=$(( __mcode_backslash_length + 1024 )) ;;
    esac
  done
  while (( __mcode_backslash_length < __mcode_output_length )); do
    __mcode_character="\${__mcode_value:__mcode_output_length - __mcode_backslash_length - 1:1}"
    [[ "$__mcode_character" == '\\' ]] || break
    __mcode_backslash_length=$(( __mcode_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __mcode_suffix_length > 0 && __mcode_backslash_length % 2 == 1 )); then
    __mcode_suffix_length=$(( __mcode_suffix_length - 1 ))
    __mcode_backslash_length=0
  fi
  __mcode_output_length=$(( \${#__mcode_value} - __mcode_suffix_length ))
  __mcode_value="\${__mcode_value:0:__mcode_output_length}"
  # Bash 4.4-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __mcode_suffix_length == 0 && ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __mcode_backslash_length % 2 == 1 )); then
    __mcode_value="$__mcode_value\\\\"
  fi
  printf -v "$__mcode_output_name" '%s' "$__mcode_value"
}
__mcode_restore_prompt_status() {
  return "$1"
}
__mcode_update_user_debug_trap() {
  local __mcode_debug_trap_spec="$1" __mcode_unchanged_debug_trap_spec="$2"
  local __mcode_debug_trap_command
  [[ "$__mcode_debug_trap_spec" != "$__mcode_unchanged_debug_trap_spec" ]] || return 0
  [[ "$__mcode_debug_trap_spec" != "trap -- '__mcode_osc133_preexec' DEBUG" ]] || return 0
  if [[ -z "$__mcode_debug_trap_spec" ]]; then
    __mcode_user_debug_trap=""
    unset __mcode_chained_debug_trap
    return 0
  fi
  __mcode_debug_trap_command="\${__mcode_debug_trap_spec#trap -- }"
  __mcode_debug_trap_command="\${__mcode_debug_trap_command% DEBUG}"
  eval "__mcode_user_debug_trap=$__mcode_debug_trap_command"
  unset __mcode_chained_debug_trap
}
__mcode_run_user_debug_trap() {
  if [[ -n "\${__mcode_user_debug_trap:-}" ]]; then
    eval "$__mcode_user_debug_trap" || true
  fi
}
__mcode_adopt_outer_debug_trap() {
  local __mcode_debug_trap_spec="\${__mcode_outer_debug_trap_spec:-}"
  unset __mcode_outer_debug_trap_spec
  __mcode_update_user_debug_trap "$__mcode_debug_trap_spec" "trap -- '__mcode_osc133_preexec' DEBUG"
}
__mcode_run_prompt_command_array() {
  local __mcode_exit_code="\${__mcode_prompt_status:-$?}" __mcode_prompt_part __mcode_prompt_index __mcode_user_count
  local __mcode_suffix_part
  local __mcode_final_prompt_command
  local __mcode_in_prompt_dispatch=1 __mcode_dispatching_user_prompt_command=""
  unset __mcode_prompt_status
  __mcode_adopt_outer_debug_trap
  trap '__mcode_osc133_preexec' DEBUG
  for __mcode_prompt_part in "\${__mcode_prompt_command_prefix[@]+"\${__mcode_prompt_command_prefix[@]}"}"; do
    if (( __mcode_exit_code == 0 )); then
      eval "$__mcode_prompt_part"
    else
      __mcode_restore_prompt_status "$__mcode_exit_code" || eval "$__mcode_prompt_part"
    fi
  done
  __mcode_user_count=0
  for __mcode_prompt_part in "\${__mcode_prompt_command_array[@]+"\${__mcode_prompt_command_array[@]}"}"; do
    __mcode_user_count=$(( __mcode_user_count + 1 ))
  done
  for (( __mcode_prompt_index = 0; __mcode_prompt_index + 1 < __mcode_user_count; __mcode_prompt_index++ )); do
    __mcode_prompt_part="\${__mcode_prompt_command_array[__mcode_prompt_index]}"
    __mcode_dispatching_user_prompt_command=1
    if (( __mcode_exit_code == 0 )); then
      eval "$__mcode_prompt_part"
    else
      __mcode_restore_prompt_status "$__mcode_exit_code" || eval "$__mcode_prompt_part"
    fi
    __mcode_dispatching_user_prompt_command=""
  done
  if (( __mcode_user_count > 0 )); then
    __mcode_prompt_part="\${__mcode_prompt_command_array[__mcode_user_count - 1]}"
    # Why: keep the final user hook and MCode suffixes in one status-preserving eval.
    __mcode_final_prompt_command='eval "$__mcode_prompt_part"'
    for __mcode_suffix_part in "\${__mcode_prompt_command_suffix[@]+"\${__mcode_prompt_command_suffix[@]}"}"; do
      __mcode_final_prompt_command+=$'\\n'"$__mcode_suffix_part"
    done
    __mcode_dispatching_user_prompt_command=1
    if (( __mcode_exit_code == 0 )); then
      eval "$__mcode_final_prompt_command"
    else
      __mcode_restore_prompt_status "$__mcode_exit_code" || eval "$__mcode_final_prompt_command"
    fi
    __mcode_dispatching_user_prompt_command=""
  else
    for __mcode_prompt_part in "\${__mcode_prompt_command_suffix[@]+"\${__mcode_prompt_command_suffix[@]}"}"; do
      if (( __mcode_exit_code == 0 )); then
        eval "$__mcode_prompt_part"
      else
        __mcode_restore_prompt_status "$__mcode_exit_code" || eval "$__mcode_prompt_part"
      fi
    done
  fi
  return "$__mcode_exit_code"
}
__mcode_finish_legacy_prompt_dispatch() {
  local __mcode_suffix_part
  if [[ -n "\${__mcode_in_prompt_command:-}" ]]; then
    for __mcode_suffix_part in "\${__mcode_prompt_command_suffix[@]+"\${__mcode_prompt_command_suffix[@]}"}"; do
      eval "$__mcode_suffix_part"
    done
  fi
  trap '__mcode_osc133_preexec' DEBUG
  unset __mcode_in_legacy_prompt_wrapper
}
__mcode_normalize_prompt_command() {
  [[ -z "\${__mcode_prompt_command_normalized:-}" ]] || return 0
  local __mcode_prompt_part
  local -a __mcode_normalized=()
  for __mcode_prompt_part in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
    __mcode_normalize_prompt_command_part "$__mcode_prompt_part" __mcode_prompt_part
    [[ -n "$__mcode_prompt_part" ]] && __mcode_normalized+=("$__mcode_prompt_part")
  done
  __mcode_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__mcode_normalized[@]+"\${__mcode_normalized[@]}"}")
  else
    __mcode_prompt_command_array=("\${__mcode_normalized[@]+"\${__mcode_normalized[@]}"}")
    __mcode_prompt_command_prefix=()
    __mcode_prompt_command_suffix=()
    unset PROMPT_COMMAND
    # Why: PID scope distinguishes legacy prompt dispatch from ordinary user command text.
    __mcode_prompt_status_variable="__mcode_prompt_status_$$"
    __mcode_prompt_status_capture_command="$__mcode_prompt_status_variable=\\$?"
    __mcode_prompt_status_value="\\\${$__mcode_prompt_status_variable}"
    PROMPT_COMMAND="$__mcode_prompt_status_capture_command; __mcode_prompt_status=$__mcode_prompt_status_value"'; __mcode_prompt_had_functrace=""; if [[ -o functrace ]]; then __mcode_prompt_had_functrace=1; set +T; fi; __mcode_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__mcode_prompt_had_functrace" ]] || set -T; unset __mcode_prompt_had_functrace; __mcode_run_prompt_command_array; __mcode_finish_legacy_prompt_dispatch'
  fi
}
__mcode_prepend_prompt_command() {
  local command="$1"
  __mcode_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}")
  else
    __mcode_prompt_command_prefix=("$command" "\${__mcode_prompt_command_prefix[@]+"\${__mcode_prompt_command_prefix[@]}"}")
  fi
}
__mcode_append_prompt_command() {
  local command="$1"
  __mcode_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __mcode_prompt_command_suffix+=("$command")
  fi
}`
