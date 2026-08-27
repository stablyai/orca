import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from '../bash-prompt-command-composition'
import { BASH_FEATURE_CHANNEL_BLOCK, SHELL_STARTUP_IDENTITY_MARKER_BLOCK } from '../shell-templates'
import { SHELL_READY_MARKER } from './daemon-shell-ready-marker'

export function getDaemonBashShellReadyRcfileContent(): string {
  return `# Orca daemon bash shell-ready wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why a plain variable: the channel is consumed and destroyed in these first
# lines, so nothing this shell later spawns can see or inherit the selection.
__orca_ready_marker=""
__orca_has_feature ready && __orca_ready_marker=1
unset _orca_shell_features
unset -f __orca_has_feature
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so Orca can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~); without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${ORCA_AGENT_TEAMS_SHIM_DIR}"|"\${ORCA_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${ORCA_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__orca_restore_agent_teams_path
# Why: user startup files may set the default OpenCode config after Orca's
# spawn env; restore the Orca-managed config dir before the first prompt.
[[ -n "\${ORCA_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${ORCA_OPENCODE_CONFIG_DIR}"
[[ -n "\${ORCA_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${ORCA_MIMOCODE_HOME}"
${getPosixOmpShellWrapper()}
# Why: Codex must keep using Orca's runtime CODEX_HOME after profile scripts.
[[ -n "\${ORCA_CODEX_HOME:-}" ]] && export CODEX_HOME="\${ORCA_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight()}
# Why: emit OSC 133 C/D so terminal-command-lifecycle can drop stale agent
# status when the foreground command exits — mirrors the zsh daemon wrapper.
# Without this, bash users (default on most Linux distros) keep a stuck
# 'working' spinner after the CLI exits without a Stop/SessionEnd hook.
__orca_initializing_wrapper=1
__orca_osc133_precmd() {
  local exit_code=$?
  __orca_in_prompt_command=1
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
  # Why: emit the shell-ready marker here (not a trailing PROMPT_COMMAND entry)
  # so a framework that must be last in PROMPT_COMMAND — bash-preexec — is not
  # displaced by one of Orca's own hooks.
  [[ -n "$__orca_ready_marker" ]] && printf "${SHELL_READY_MARKER}"
  return "$exit_code"
}
__orca_osc133_preexec() {
  if [[ -n "\${__orca_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__orca_prompt_status_capture_command" ]]; then
    unset __orca_initial_prompt
    __orca_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__orca_initializing_wrapper:-}\${__orca_in_debug_capture:-}\${__orca_initial_prompt:-}\${__orca_in_prompt_dispatch:-}\${__orca_in_legacy_prompt_wrapper:-}\${__orca_in_prompt_command:-}" ]]; then
    [[ -z "\${__orca_initializing_wrapper:-}\${__orca_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__orca_initial_prompt:-}" && "$BASH_COMMAND" == "__orca_osc133_precmd" ]]; then
      unset __orca_initial_prompt; return 0
    fi
    if [[ -n "\${__orca_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__orca_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__orca_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __orca_exit_code == 0 ))'|'__orca_restore_prompt_status "$__orca_exit_code"'|'eval "$__orca_prompt_part"'|'eval "$__orca_final_prompt_command"'|__orca_dispatching_user_prompt_command=*|__orca_osc133_precmd|__orca_osc133_epilogue) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__orca_run_prompt_command_array" || "$BASH_COMMAND" == "__orca_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__orca_in_legacy_prompt_wrapper:-}" || -n "\${__orca_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__orca_in_prompt_command:-}" && "$BASH_COMMAND" == "__orca_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in
    __orca_osc133_*|__orca_restore_prompt_status|__bp_*) return 0 ;;
  esac
  case "$BASH_COMMAND" in
    __orca_osc133_precmd|__orca_osc133_epilogue) return 0 ;;
    # The prefix is only special while bash-preexec prompt hooks run.
    __bp_*) [[ -n "\${__orca_in_prompt_command:-}" ]] && return 0 ;;
  esac
  __orca_run_user_debug_trap
  # Why: a framework (bash-preexec/starship) may replace our DEBUG trap at the
  # first prompt; __orca_osc133_epilogue re-takes it each prompt and stores the
  # framework's trap here, so the framework's own preexec still runs while our
  # command-start C survives its re-arm.
  if [[ -n "\${__orca_chained_debug_trap:-}" ]]; then
    eval "$__orca_chained_debug_trap" || true
  fi
  [[ -z "\${__orca_in_prompt_command:-}" ]] || return 0
  # Why: a chained trap can invoke us more than once for a single command, so
  # emit C only on the first fire (the __orca_in_command gate), and never for a
  # prompt-time hook — ours or bash-preexec's __bp_* helpers.
  [[ -z "\${__orca_in_command:-}" ]] || return 0
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
# Why: adopt the latest user trap before Orca retakes lifecycle ownership.
__orca_osc133_epilogue() {
  unset __orca_in_prompt_command
  __orca_adopt_outer_debug_trap
  trap '__orca_osc133_preexec' DEBUG
}
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__orca_prepend_prompt_command "__orca_osc133_precmd"
__orca_append_prompt_command '__orca_in_debug_capture=1; __orca_prompt_had_functrace=""; if [[ -o functrace ]]; then __orca_prompt_had_functrace=1; set +T; fi; __orca_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__orca_prompt_had_functrace" ]] || set -T; unset __orca_prompt_had_functrace __orca_in_debug_capture'
__orca_append_prompt_command "__orca_osc133_epilogue"
__orca_had_functrace=""
[[ -o functrace ]] && __orca_had_functrace=1
set +T
__orca_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__orca_had_functrace" ]] || set -T
if [[ -n "$__orca_debug_trap_spec" && "$__orca_debug_trap_spec" != "trap -- '__orca_osc133_preexec' DEBUG" ]]; then
  __orca_debug_trap_command="\${__orca_debug_trap_spec#trap -- }"
  __orca_debug_trap_command="\${__orca_debug_trap_command% DEBUG}"
  eval "__orca_user_debug_trap=$__orca_debug_trap_command"
fi
unset __orca_debug_trap_spec __orca_debug_trap_command __orca_had_functrace
unset -f __orca_normalize_prompt_command_part __orca_normalize_prompt_command __orca_prepend_prompt_command __orca_append_prompt_command
unset __orca_prompt_command_normalized
# Why: arm DEBUG after wrapper setup; otherwise bash treats our own rcfile
# commands as a foreground command and emits a fake C/D before the first prompt.
__orca_initial_prompt=1
trap '__orca_osc133_preexec' DEBUG
unset __orca_initializing_wrapper
`
}
