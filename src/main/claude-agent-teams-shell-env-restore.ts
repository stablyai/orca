/**
 * Re-applies Orca's Claude Agent Teams PATH and SHELL after the user's startup files ran.
 * Valid in both bash and zsh. The it2 shim dir (iterm2 mode) leads the tmux shim dir, and SHELL
 * returns to the it2 probe shell if a startup file replaced it.
 */
export const CLAUDE_AGENT_TEAMS_POSIX_ENV_RESTORE = `__orca_restore_agent_teams_path() {
  [[ -n "\${ORCA_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  local __orca_agent_teams_lead="\${ORCA_AGENT_TEAMS_SHIM_DIR}"
  [[ -n "\${ORCA_AGENT_TEAMS_IT2_SHIM_DIR:-}" ]] && __orca_agent_teams_lead="\${ORCA_AGENT_TEAMS_IT2_SHIM_DIR}:\${__orca_agent_teams_lead}"
  case "$PATH" in
    "\${__orca_agent_teams_lead}"|"\${__orca_agent_teams_lead}:"*) ;;
    *) export PATH="\${__orca_agent_teams_lead}:$PATH" ;;
  esac
  # Why: Claude finds it2 through "$SHELL -lc 'command -v it2'", so a reset SHELL would bypass the shim.
  if [[ -n "\${ORCA_AGENT_TEAMS_IT2_PROBE_SHELL:-}" && "\${SHELL:-}" != "\${ORCA_AGENT_TEAMS_IT2_PROBE_SHELL}" ]]; then
    export SHELL="\${ORCA_AGENT_TEAMS_IT2_PROBE_SHELL}"
  fi
}
__orca_restore_agent_teams_path`
