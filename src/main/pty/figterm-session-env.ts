// Why: Kiro CLI / Amazon Q figterm exports these inside its own PTY, and its shell
// integration skips launching figterm while Q_TERM is set. When Orca is started from a
// figterm-wrapped terminal, the markers would claim every Orca pane is already wrapped.
export const FIGTERM_SESSION_ENV_KEYS = ['Q_TERM', 'Q_TERM_TMUX', 'QTERM_SESSION_ID'] as const

/** A new Orca pane is not inside the figterm session that launched Orca. */
export function removeInheritedFigtermSessionEnv(env: Record<string, string | undefined>): void {
  for (const key of FIGTERM_SESSION_ENV_KEYS) {
    delete env[key]
  }
}
