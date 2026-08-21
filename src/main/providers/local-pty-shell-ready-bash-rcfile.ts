/**
 * Content of the bash rcfile MCode launches interactive bash with.
 *
 * Why: bash gets a single `--rcfile` wrapper (not a ZDOTDIR tree), so the login
 * startup-file chain, OSC 133 hooks, and the shell-ready marker all live here.
 */
import { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from '../bash-prompt-command-composition'
import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { BASH_FEATURE_CHANNEL_BLOCK, SHELL_STARTUP_IDENTITY_MARKER_BLOCK } from '../shell-templates'
import { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-marker'

export function getBashShellReadyRcfileContent(): string {
  return `# MCode bash shell-ready wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Why a plain variable: the channel is consumed and destroyed in these first
# lines, so nothing this shell later spawns can see or inherit the selection.
__mcode_ready_marker=""
__mcode_has_feature ready && __mcode_ready_marker=1
unset _mcode_shell_features
unset -f __mcode_has_feature
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so MCode can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~). Without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
# Why: preserve bash's normal login-shell contract. Many users already source
# ~/.bashrc from ~/.bash_profile; forcing ~/.bashrc again here would duplicate
# PATH edits, hooks, and prompt init in MCode startup-command shells.
__mcode_restore_agent_teams_path() {
  [[ -n "\${MCODE_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${MCODE_AGENT_TEAMS_SHIM_DIR}"|"\${MCODE_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${MCODE_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__mcode_restore_agent_teams_path
# Why: user startup files may set the default OpenCode config after MCode's
# spawn env; restore the MCode-managed config dir before the first prompt.
[[ -n "\${MCODE_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${MCODE_OPENCODE_CONFIG_DIR}"
[[ -n "\${MCODE_MIMOCODE_HOME:-}" ]] && export MIMOCODE_HOME="\${MCODE_MIMOCODE_HOME}"
${getPosixOmpShellWrapper()}
# Why: Codex must keep using MCode's runtime CODEX_HOME after profile scripts.
[[ -n "\${MCODE_CODEX_HOME:-}" ]] && export CODEX_HOME="\${MCODE_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight()}
# Why: emit OSC 133 C/D so terminal-command-lifecycle can drop stale agent
# status when the foreground command (e.g. an interrupted Claude/Codex CLI)
# exits — mirrors the zsh wrapper. Without this, bash users (default on most
# Linux distros) keep a stuck 'working' spinner for up to 30 min after the
# CLI exits without sending a Stop/SessionEnd hook.
__mcode_initializing_wrapper=1
__mcode_osc133_precmd() {
  local exit_code=$?
  __mcode_in_prompt_command=1
  if [[ -n "\${__mcode_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __mcode_in_command
  fi
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__mcode_osc133_prompt_done() {
  unset __mcode_in_prompt_command
  __mcode_adopt_outer_debug_trap
  trap '__mcode_osc133_preexec' DEBUG
}
__mcode_osc133_preexec() {
  if [[ -n "\${__mcode_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__mcode_prompt_status_capture_command" ]]; then
    unset __mcode_initial_prompt
    __mcode_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__mcode_initializing_wrapper:-}\${__mcode_in_debug_capture:-}\${__mcode_initial_prompt:-}\${__mcode_in_prompt_dispatch:-}\${__mcode_in_legacy_prompt_wrapper:-}\${__mcode_in_prompt_command:-}" ]]; then
    [[ -z "\${__mcode_initializing_wrapper:-}\${__mcode_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__mcode_initial_prompt:-}" && "$BASH_COMMAND" == "__mcode_osc133_precmd" ]]; then
      unset __mcode_initial_prompt; return 0
    fi
    if [[ -n "\${__mcode_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__mcode_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__mcode_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __mcode_exit_code == 0 ))'|'__mcode_restore_prompt_status "$__mcode_exit_code"'|'eval "$__mcode_prompt_part"'|'eval "$__mcode_final_prompt_command"'|__mcode_dispatching_user_prompt_command=*|__mcode_osc133_precmd|__mcode_osc133_prompt_done|__mcode_prompt_mark) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__mcode_run_prompt_command_array" || "$BASH_COMMAND" == "__mcode_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__mcode_in_legacy_prompt_wrapper:-}" || -n "\${__mcode_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__mcode_in_prompt_command:-}" && "$BASH_COMMAND" == "__mcode_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in __mcode_osc133_*|__mcode_prompt_mark|__mcode_restore_prompt_status) return 0 ;; esac
  case "$BASH_COMMAND" in __mcode_osc133_precmd|__mcode_osc133_prompt_done|__mcode_prompt_mark) return 0 ;; esac
  __mcode_run_user_debug_trap
  [[ -z "\${__mcode_in_prompt_command:-}" ]] || return 0
  [[ -z "\${__mcode_in_command:-}" ]] || return 0
  # Why: bash DEBUG fires for every simple command, including PROMPT_COMMAND
  # bodies and chained traps can call us repeatedly for one command.
  printf "\\033]133;C\\007"
  __mcode_in_command=1
}
# Why: prepend so we capture $? before the user's PROMPT_COMMAND chain mutates it.
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__mcode_prepend_prompt_command "__mcode_osc133_precmd"
# Why: append the marker through PROMPT_COMMAND so it fires after the login
# startup files have rebuilt the prompt, without re-running user rc files.
if [[ -n "$__mcode_ready_marker" ]]; then
  __mcode_prompt_mark() {
    printf "${SHELL_READY_MARKER_ESCAPED}"
  }
  __mcode_append_prompt_command "__mcode_prompt_mark"
fi
__mcode_append_prompt_command '__mcode_in_debug_capture=1; __mcode_prompt_had_functrace=""; if [[ -o functrace ]]; then __mcode_prompt_had_functrace=1; set +T; fi; __mcode_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__mcode_prompt_had_functrace" ]] || set -T; unset __mcode_prompt_had_functrace __mcode_in_debug_capture'
__mcode_append_prompt_command "__mcode_osc133_prompt_done"
__mcode_had_functrace=""
[[ -o functrace ]] && __mcode_had_functrace=1
set +T
__mcode_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__mcode_had_functrace" ]] || set -T
if [[ -n "$__mcode_debug_trap_spec" && "$__mcode_debug_trap_spec" != "trap -- '__mcode_osc133_preexec' DEBUG" ]]; then
  __mcode_debug_trap_command="\${__mcode_debug_trap_spec#trap -- }"
  __mcode_debug_trap_command="\${__mcode_debug_trap_command% DEBUG}"
  eval "__mcode_user_debug_trap=$__mcode_debug_trap_command"
fi
unset __mcode_debug_trap_spec __mcode_debug_trap_command __mcode_had_functrace
unset -f __mcode_normalize_prompt_command_part __mcode_normalize_prompt_command __mcode_prepend_prompt_command __mcode_append_prompt_command
unset __mcode_prompt_command_normalized
# Why: arm DEBUG after wrapper setup; otherwise bash treats our own rcfile
# commands as a foreground command and emits a fake C/D before the first prompt.
__mcode_initial_prompt=1
trap '__mcode_osc133_preexec' DEBUG
unset __mcode_initializing_wrapper
`
}
