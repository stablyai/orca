export const ORCA_INHERITED_TMUX_ENV = 'ORCA_INHERITED_TMUX'

/** Names the tmux pane Orca itself runs in, so hooks don't take it for a tmux started in the pane. */
export function stampInheritedTmuxEnv(
  env: Record<string, string | undefined>,
  explicitEnv: Record<string, string> | undefined
): void {
  delete env[ORCA_INHERITED_TMUX_ENV]
  const { TMUX: tmux, TMUX_PANE: pane } = env
  if (!tmux || !pane || explicitEnv?.TMUX !== undefined || explicitEnv?.TMUX_PANE !== undefined) {
    return
  }
  // Same "<pane> <socket>" shape the hook scripts report: TMUX minus its ",pid,session" tail.
  env[ORCA_INHERITED_TMUX_ENV] = `${pane} ${tmux.replace(/,[^,]*,[^,]*$/, '')}`
}
