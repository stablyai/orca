/**
 * Content of the bash rcfile Orca launches interactive bash with.
 *
 * Why: bash gets a single `--rcfile` wrapper (not a ZDOTDIR tree), so the login
 * startup-file chain, OSC 133 hooks, and the shell-ready marker all live here.
 */
import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { getPosixCodexShellLaunchPreflight } from '../pty/codex-shell-launch-preflight'
import { SHELL_STARTUP_IDENTITY_MARKER_BLOCK } from '../shell-templates'
import { SHELL_READY_MARKER_ESCAPED } from './local-pty-shell-ready-wrapper-root'

export function getBashShellReadyRcfileContent(): string {
  return `# Orca bash shell-ready wrapper
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: enable bracketed paste so Orca can deliver a multiline startup prompt as
# a single literal paste (ESC[200~…ESC[201~). Without it, older readline builds
# treat each embedded newline as Enter and mangle the prompt into PS2
# continuation. Modern readline defaults this on; force it for the rest.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
# Why: preserve bash's normal login-shell contract. Many users already source
# ~/.bashrc from ~/.bash_profile; forcing ~/.bashrc again here would duplicate
# PATH edits, hooks, and prompt init in Orca startup-command shells.
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
# status when the foreground command (e.g. an interrupted Claude/Codex CLI)
# exits — mirrors the zsh wrapper. Without this, bash users (default on most
# Linux distros) keep a stuck 'working' spinner for up to 30 min after the
# CLI exits without sending a Stop/SessionEnd hook.
__orca_osc133_precmd() {
  local exit_code=$?
  __orca_in_prompt_command=1
  if [[ -n "\${__orca_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __orca_in_command
  fi
  printf "\\033]133;A\\007"
}
__orca_osc133_prompt_done() {
  unset __orca_in_prompt_command
}
__orca_run_user_debug_trap() {
  if [[ -n "\${__orca_user_debug_trap:-}" ]]; then
    eval "$__orca_user_debug_trap" || true
  fi
}
__orca_osc133_preexec() {
  __orca_run_user_debug_trap
  [[ -z "\${__orca_in_prompt_command:-}" ]] || return
  # Why: bash DEBUG fires for every simple command, including PROMPT_COMMAND
  # bodies. Skip our own prompt-time helpers so they don't mark the shell as
  # "in command" before the prompt has even drawn.
  case "$BASH_COMMAND" in
    *__orca_osc133_precmd*|*__orca_osc133_prompt_done*|*__orca_prompt_mark*) return ;;
  esac
  printf "\\033]133;C\\007"
  __orca_in_command=1
}
# Why: prepend so we capture $? before the user's PROMPT_COMMAND chain mutates it.
__orca_normalize_prompt_command() {
  local __orca_joined="" __orca_prompt_part
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    for __orca_prompt_part in "\${PROMPT_COMMAND[@]}"; do
      [[ -n "$__orca_prompt_part" ]] || continue
      if [[ -n "$__orca_joined" ]]; then
        __orca_joined="$__orca_joined;$__orca_prompt_part"
      else
        __orca_joined="$__orca_prompt_part"
      fi
    done
    PROMPT_COMMAND="$__orca_joined"
  fi
}
__orca_prepend_prompt_command() {
  __orca_normalize_prompt_command
  PROMPT_COMMAND="__orca_osc133_precmd\${PROMPT_COMMAND:+;\${PROMPT_COMMAND}}"
}
__orca_append_prompt_command() {
  local command="$1"
  __orca_normalize_prompt_command
  if [[ -n "\${PROMPT_COMMAND:-}" ]]; then
    PROMPT_COMMAND="\${PROMPT_COMMAND};$command"
  else
    PROMPT_COMMAND="$command"
  fi
}
__orca_prepend_prompt_command
# Why: append the marker through PROMPT_COMMAND so it fires after the login
# startup files have rebuilt the prompt, without re-running user rc files.
if [[ "\${ORCA_SHELL_READY_MARKER:-0}" == "1" ]]; then
  __orca_prompt_mark() {
    printf "${SHELL_READY_MARKER_ESCAPED}"
  }
  __orca_append_prompt_command "__orca_prompt_mark"
fi
__orca_append_prompt_command "__orca_osc133_prompt_done"
__orca_debug_trap_spec="$(trap -p DEBUG)"
if [[ -n "$__orca_debug_trap_spec" ]]; then
  __orca_debug_trap_command="\${__orca_debug_trap_spec#trap -- }"
  __orca_debug_trap_command="\${__orca_debug_trap_command% DEBUG}"
  eval "__orca_user_debug_trap=$__orca_debug_trap_command"
fi
unset __orca_debug_trap_spec __orca_debug_trap_command
unset -f __orca_normalize_prompt_command __orca_prepend_prompt_command __orca_append_prompt_command
# Why: arm DEBUG after wrapper setup; otherwise bash treats our own rcfile
# commands as a foreground command and emits a fake C/D before the first prompt.
trap '__orca_osc133_preexec' DEBUG
`
}
