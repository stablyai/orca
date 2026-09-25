import type { TerminalTab } from '../../shared/terminal-tab-types'

/**
 * The pane label that is NOT predecessor-owned automatic evidence.
 *
 * `customTitle` is the user's rename, `generatedTitle` the opt-in agent-prompt label and
 * `defaultTitle` the stable "Terminal N" fallback. `title` is excluded deliberately: it is the
 * live label the replaced process authored, which is exactly what a proven replacement retires.
 * Returns null when no stable label exists, so retiring can never leave a pane unnamed.
 */
export function stableTerminalSurfaceLabel(tab: TerminalTab | null | undefined): string | null {
  return (
    tab?.customTitle?.trim() || tab?.generatedTitle?.trim() || tab?.defaultTitle?.trim() || null
  )
}

/**
 * The label a replaced surface should carry, or null when there is nothing to retire — either
 * because no stable label exists or because the surface already shows it.
 */
export function retiredTerminalSurfaceTitle(
  currentTitle: string | null | undefined,
  persistedTab: TerminalTab | null | undefined
): string | null {
  const stable = stableTerminalSurfaceLabel(persistedTab)
  if (stable === null || currentTitle?.trim() === stable) {
    return null
  }
  return stable
}
