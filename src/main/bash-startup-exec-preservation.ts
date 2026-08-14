// Preserves Bash prompt instrumentation when startup files replace the shell with exec.

export function getBashStartupExecPreservationStart(escapedReadyMarker: string): string {
  return `_orca_exec_prompt_hooks_installed=0
__orca_exec_osc133_precmd() {
  local exit_code=$?
  __orca_exec_in_prompt_command=1
  if [[ -n "\${__orca_exec_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_exec_in_command
  fi
  printf "\\033]133;A\\007"
  [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]] && printf "${escapedReadyMarker}"
}
__orca_exec_osc133_preexec() {
  if [[ -n "\${__orca_exec_chained_debug_trap:-}" ]]; then
    eval "$__orca_exec_chained_debug_trap" || true
  fi
  [[ -z "\${__orca_exec_in_prompt_command:-}" ]] || return
  [[ -z "\${__orca_exec_in_command:-}" ]] || return
  case "$BASH_COMMAND" in *__orca_exec_osc133_*) return ;; esac
  printf "\\033]133;C\\007"
  __orca_exec_in_command=1
}
__orca_exec_osc133_prompt_done() {
  local _orca_exec_debug_spec="$(trap -p DEBUG)"
  case "$_orca_exec_debug_spec" in
    ""|*__orca_exec_osc133_preexec*) __orca_exec_chained_debug_trap="" ;;
    *)
      _orca_exec_debug_spec="\${_orca_exec_debug_spec#trap -- }"
      _orca_exec_debug_spec="\${_orca_exec_debug_spec% DEBUG}"
      eval "__orca_exec_chained_debug_trap=$_orca_exec_debug_spec"
      ;;
  esac
  trap '__orca_exec_osc133_preexec' DEBUG
  unset __orca_exec_in_prompt_command
  if [[ "\${_orca_exec_prompt_command_was_exported:-0}" != "1" ]]; then
    export -nf __orca_exec_osc133_precmd __orca_exec_osc133_preexec __orca_exec_osc133_prompt_done
    export -n PROMPT_COMMAND
    unset _orca_exec_prompt_command_was_exported
  fi
}
_orca_exec_precmd_body="$(declare -f __orca_exec_osc133_precmd)"
_orca_exec_preexec_body="$(declare -f __orca_exec_osc133_preexec)"
_orca_exec_prompt_done_body="$(declare -f __orca_exec_osc133_prompt_done)"
export -f __orca_exec_osc133_precmd __orca_exec_osc133_preexec __orca_exec_osc133_prompt_done
__orca_install_exec_prompt_hooks() {
  local _orca_exec_joined="" _orca_exec_prompt_part
  if [[ "\${_orca_exec_prompt_hooks_installed:-0}" != "1" ]]; then
    _orca_exec_prompt_command_was_exported=0
    _orca_exec_prompt_declaration="$(declare -p PROMPT_COMMAND 2>/dev/null)"
    case "\${_orca_exec_prompt_declaration%% PROMPT_COMMAND=*}" in
      *x*) _orca_exec_prompt_command_was_exported=1 ;;
    esac
    export _orca_exec_prompt_command_was_exported
    _orca_exec_prompt_hooks_installed=1
  fi
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    for _orca_exec_prompt_part in "\${PROMPT_COMMAND[@]}"; do
      [[ -n "$_orca_exec_prompt_part" ]] || continue
      _orca_exec_joined="\${_orca_exec_joined}\${_orca_exec_joined:+;}$_orca_exec_prompt_part"
    done
    unset PROMPT_COMMAND
    PROMPT_COMMAND="$_orca_exec_joined"
  fi
  PROMPT_COMMAND="\${PROMPT_COMMAND:-}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//__orca_exec_osc133_precmd;/}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//;__orca_exec_osc133_precmd/}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//__orca_exec_osc133_prompt_done;/}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//;__orca_exec_osc133_prompt_done/}"
  [[ "$PROMPT_COMMAND" != "__orca_exec_osc133_precmd" ]] || PROMPT_COMMAND=""
  [[ "$PROMPT_COMMAND" != "__orca_exec_osc133_prompt_done" ]] || PROMPT_COMMAND=""
  PROMPT_COMMAND="__orca_exec_osc133_precmd\${PROMPT_COMMAND:+;\${PROMPT_COMMAND}};__orca_exec_osc133_prompt_done"
  export PROMPT_COMMAND
}
_orca_exec_install_body="$(declare -f __orca_install_exec_prompt_hooks)"
_orca_exec_functrace_was_set=0
shopt -qo functrace && _orca_exec_functrace_was_set=1
_orca_exec_startup_debug_spec="$(builtin trap -p DEBUG)"
_orca_exec_startup_debug_had_trap=0
_orca_exec_startup_chained_debug_trap=""
_orca_exec_user_enabled_functrace=0
if [[ -n "$_orca_exec_startup_debug_spec" ]]; then
  _orca_exec_startup_debug_had_trap=1
  _orca_exec_startup_debug_spec="\${_orca_exec_startup_debug_spec#trap -- }"
  _orca_exec_startup_debug_spec="\${_orca_exec_startup_debug_spec% DEBUG}"
  eval "_orca_exec_startup_chained_debug_trap=$_orca_exec_startup_debug_spec"
fi
# Why: BASH_COMMAND is source text, so only a lexical command-prefix match may arm the bridge.
__orca_startup_command_is_exec() {
  local _orca_exec_command="$1" _orca_exec_char _orca_exec_previous
  local _orca_exec_word="" _orca_exec_quote="" _orca_exec_name=""
  local _orca_exec_index=0 _orca_exec_nested_parens=0 _orca_exec_nested_braces=0
  local _orca_exec_modifier=0 _orca_exec_escaped=0 _orca_exec_found=0
  local _orca_exec_has_redirection=0 _orca_exec_skip_option_value=0
  local _orca_exec_skip_redirection_target=0 _orca_exec_options_done=0
  local _orca_exec_redirection_prefix=""
  while (( _orca_exec_index <= \${#_orca_exec_command} )); do
    if (( _orca_exec_index == \${#_orca_exec_command} )); then
      _orca_exec_char=" "
    else
      _orca_exec_char="\${_orca_exec_command:_orca_exec_index:1}"
    fi
    if (( _orca_exec_escaped )); then
      _orca_exec_escaped=0
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    elif [[ "$_orca_exec_char" == "\\\\" && "$_orca_exec_quote" != "'" ]]; then
      _orca_exec_escaped=1
    elif [[ -n "$_orca_exec_quote" ]]; then
      if [[ "$_orca_exec_char" == "$_orca_exec_quote" ]]; then
        _orca_exec_quote=""
      else
        _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
      fi
    elif [[ "$_orca_exec_char" == "'" || "$_orca_exec_char" == '"' ||
      "$_orca_exec_char" == $'\\x60' ]]; then
      _orca_exec_quote="$_orca_exec_char"
    elif (( _orca_exec_nested_parens > 0 )); then
      [[ "$_orca_exec_char" != "(" ]] || (( _orca_exec_nested_parens++ ))
      [[ "$_orca_exec_char" != ")" ]] || (( _orca_exec_nested_parens-- ))
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    elif (( _orca_exec_nested_braces > 0 )); then
      [[ "$_orca_exec_char" != "{" ]] || (( _orca_exec_nested_braces++ ))
      [[ "$_orca_exec_char" != "}" ]] || (( _orca_exec_nested_braces-- ))
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    elif [[ "$_orca_exec_char" == "(" &&
      ( "$_orca_exec_previous" == "$" || "$_orca_exec_previous" == "<" || "$_orca_exec_previous" == ">" ) ]]; then
      _orca_exec_nested_parens=1
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    elif [[ "$_orca_exec_char" == "{" && "$_orca_exec_previous" == "$" ]]; then
      _orca_exec_nested_braces=1
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    elif [[ "$_orca_exec_char" == "<" || "$_orca_exec_char" == ">" ]]; then
      if (( !_orca_exec_has_redirection )); then
        _orca_exec_redirection_prefix="$_orca_exec_word"
        _orca_exec_has_redirection=1
      fi
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    elif [[ "$_orca_exec_char" == [[:space:]] ]]; then
      if [[ -n "$_orca_exec_word" ]]; then
        if (( !_orca_exec_found && _orca_exec_has_redirection )) &&
          [[ "$_orca_exec_redirection_prefix" == "exec" ]]; then
          _orca_exec_found=1
          _orca_exec_redirection_prefix=""
        fi
        if (( _orca_exec_found )); then
          if (( _orca_exec_skip_redirection_target )); then
            _orca_exec_skip_redirection_target=0
          elif (( _orca_exec_has_redirection )); then
            if [[ -n "$_orca_exec_redirection_prefix" &&
              "$_orca_exec_redirection_prefix" == *[!0-9]* &&
              ! "$_orca_exec_redirection_prefix" =~ ^[{][a-zA-Z_][a-zA-Z0-9_]*[}]$ ]]; then
              return 0
            fi
            case "$_orca_exec_word" in
              *">"|*"<"|*">&"|*"<&"|*"<<-"|*">|") _orca_exec_skip_redirection_target=1 ;;
            esac
          elif (( _orca_exec_skip_option_value )); then
            _orca_exec_skip_option_value=0
          elif (( _orca_exec_options_done )); then
            return 0
          else
            case "$_orca_exec_word" in
              -a) _orca_exec_skip_option_value=1 ;;
              -c|-l|-cl|-lc) ;;
              --) _orca_exec_options_done=1 ;;
              -*) return 1 ;;
              *) return 0 ;;
            esac
          fi
        elif [[ "$_orca_exec_word" == "exec" ]]; then
          _orca_exec_found=1
        else
          _orca_exec_name="\${_orca_exec_word%%=*}"
          if (( !_orca_exec_modifier )) && [[ "$_orca_exec_word" == *=* &&
            "$_orca_exec_name" == [a-zA-Z_]* && "$_orca_exec_name" != *[!a-zA-Z0-9_]* ]]; then
            :
          elif (( !_orca_exec_modifier )) && [[ "$_orca_exec_word" == "builtin" || "$_orca_exec_word" == "command" ]]; then
            _orca_exec_modifier=1
          elif (( _orca_exec_modifier )) && [[ "$_orca_exec_word" == -* ]]; then
            :
          else
            return 1
          fi
        fi
        _orca_exec_word=""
        _orca_exec_has_redirection=0
        _orca_exec_redirection_prefix=""
      fi
    else
      _orca_exec_word="\${_orca_exec_word}$_orca_exec_char"
    fi
    _orca_exec_previous="$_orca_exec_char"
    (( _orca_exec_index++ ))
  done
  return 1
}
_orca_exec_command_check_body="$(declare -f __orca_startup_command_is_exec)"
__orca_preserve_startup_exec() {
  local _orca_exec_command="$BASH_COMMAND"
  if [[ -n "\${_orca_exec_startup_chained_debug_trap:-}" ]] &&
    { [[ "\${_orca_exec_functrace_was_set:-0}" == "1" ||
      "\${_orca_exec_user_enabled_functrace:-0}" == "1" ]] || (( \${#FUNCNAME[@]} <= 1 )); }; then
    eval "$_orca_exec_startup_chained_debug_trap" || true
  fi
  case "$_orca_exec_command" in
    set[[:space:]]-T|set[[:space:]]-o[[:space:]]functrace) _orca_exec_user_enabled_functrace=1 ;;
  esac
  case "$_orca_exec_command" in
    *exec*)
      if __orca_startup_command_is_exec "$_orca_exec_command" && [[ "$(type -t exec)" == "builtin" ]]; then
        __orca_install_exec_prompt_hooks
      fi
      ;;
  esac
}
_orca_exec_startup_debug_body="$(declare -f __orca_preserve_startup_exec)"
set -T
builtin trap '__orca_preserve_startup_exec' DEBUG
_orca_exec_startup_debug_installed=1`
}

export const BASH_STARTUP_EXEC_PRESERVATION_END = `if [[ "\${_orca_exec_startup_debug_installed:-0}" == "1" ]] &&
  [[ "$(declare -f __orca_preserve_startup_exec)" == "\${_orca_exec_startup_debug_body-}" ]] &&
  [[ "$(builtin trap -p DEBUG)" == *"__orca_preserve_startup_exec"* ]]; then
  if [[ "\${_orca_exec_startup_debug_had_trap:-0}" == "1" ]]; then
    builtin trap -- "\${_orca_exec_startup_chained_debug_trap-}" DEBUG
  else
    builtin trap - DEBUG
  fi
fi
if [[ "\${_orca_exec_functrace_was_set:-0}" != "1" ]] &&
  [[ "\${_orca_exec_user_enabled_functrace:-0}" != "1" ]]; then
  set +T
fi
if [[ "$(declare -f __orca_preserve_startup_exec)" == "\${_orca_exec_startup_debug_body-}" ]]; then
  unset -f __orca_preserve_startup_exec
fi
if [[ "$(declare -f __orca_startup_command_is_exec)" == "\${_orca_exec_command_check_body-}" ]]; then
  unset -f __orca_startup_command_is_exec
fi
__orca_remove_exec_prompt_hooks() {
  local _orca_exec_joined="" _orca_exec_prompt_part
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    for _orca_exec_prompt_part in "\${PROMPT_COMMAND[@]}"; do
      [[ -n "$_orca_exec_prompt_part" ]] || continue
      _orca_exec_joined="\${_orca_exec_joined}\${_orca_exec_joined:+;}$_orca_exec_prompt_part"
    done
    unset PROMPT_COMMAND
    PROMPT_COMMAND="$_orca_exec_joined"
  fi
  PROMPT_COMMAND="\${PROMPT_COMMAND:-}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//__orca_exec_osc133_precmd;/}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//;__orca_exec_osc133_precmd/}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//__orca_exec_osc133_prompt_done;/}"
  PROMPT_COMMAND="\${PROMPT_COMMAND//;__orca_exec_osc133_prompt_done/}"
  [[ "$PROMPT_COMMAND" != "__orca_exec_osc133_precmd" ]] || PROMPT_COMMAND=""
  [[ "$PROMPT_COMMAND" != "__orca_exec_osc133_prompt_done" ]] || PROMPT_COMMAND=""
}
if [[ "\${_orca_exec_prompt_hooks_installed:-0}" == "1" ]]; then
  __orca_remove_exec_prompt_hooks
fi
unset -f __orca_remove_exec_prompt_hooks
if [[ "$(declare -f __orca_exec_osc133_precmd)" == "\${_orca_exec_precmd_body-}" ]]; then
  export -nf __orca_exec_osc133_precmd
  unset -f __orca_exec_osc133_precmd
fi
if [[ "$(declare -f __orca_exec_osc133_preexec)" == "\${_orca_exec_preexec_body-}" ]]; then
  export -nf __orca_exec_osc133_preexec
  unset -f __orca_exec_osc133_preexec
fi
if [[ "$(declare -f __orca_exec_osc133_prompt_done)" == "\${_orca_exec_prompt_done_body-}" ]]; then
  export -nf __orca_exec_osc133_prompt_done
  unset -f __orca_exec_osc133_prompt_done
fi
if [[ "$(declare -f __orca_install_exec_prompt_hooks)" == "\${_orca_exec_install_body-}" ]]; then
  unset -f __orca_install_exec_prompt_hooks
fi
if [[ "\${_orca_exec_prompt_hooks_installed:-0}" == "1" ]] &&
  [[ "\${_orca_exec_prompt_command_was_exported:-0}" != "1" ]]; then
  export -n PROMPT_COMMAND
fi
unset _orca_exec_prompt_hooks_installed _orca_exec_prompt_command_was_exported _orca_exec_prompt_declaration
unset _orca_exec_precmd_body _orca_exec_preexec_body _orca_exec_prompt_done_body _orca_exec_install_body
unset _orca_exec_functrace_was_set _orca_exec_startup_debug_spec _orca_exec_startup_debug_had_trap
unset _orca_exec_startup_chained_debug_trap _orca_exec_command_check_body _orca_exec_startup_debug_body _orca_exec_startup_debug_installed
unset _orca_exec_user_enabled_functrace`

export function getBashStartupProfileSourceBlock(escapedReadyMarker: string): string {
  return `${getBashStartupExecPreservationStart(escapedReadyMarker)}
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
${BASH_STARTUP_EXEC_PRESERVATION_END}`
}
