// Kiro CLI's shell integration skips launching figterm while Q_TERM is set, so a copy inherited from the shell that started Orca disables it in every pane.
export const FIGTERM_SESSION_ENV_KEYS = ['Q_TERM', 'Q_TERM_TMUX', 'QTERM_SESSION_ID'] as const

/** A new Orca pane is not inside the figterm session that launched Orca; a value the pane's launch sets itself stays. */
export function removeInheritedFigtermSessionEnv(
  env: Record<string, string | undefined>,
  explicitEnv: Record<string, string> | undefined
): void {
  for (const key of FIGTERM_SESSION_ENV_KEYS) {
    if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
      delete env[key]
    }
  }
}
