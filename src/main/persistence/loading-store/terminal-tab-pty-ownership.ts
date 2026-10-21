import type { TerminalTab } from '../../../shared/terminal-tab-types'

type LeafPtyIds = Readonly<Record<string, string>> | undefined

/**
 * A tab row names one PTY, but a split tab holds several panes. The renderer keeps the row on
 * the first pane and refuses to let later split-pane spawns steal it (see terminal-pty-bindings.ts),
 * because a remount reattaches the tab to whatever the row says. Main must agree, or every
 * sibling pane's reattach rewrites the row and the two sides ping-pong forever.
 *
 * The row is rewritten only when it is null or points at the PTY this leaf is replacing.
 * A missing leaf is not evidence that a non-null row can be reassigned.
 */
export function tabRowPtyIdAfterLeafBinding(
  tab: Pick<TerminalTab, 'ptyId'>,
  ptyIdsByLeafId: LeafPtyIds,
  leafId: string,
  ptyId: string
): string {
  const current = tab.ptyId
  if (current === null || current === ptyIdsByLeafId?.[leafId]) {
    return ptyId
  }
  return current
}
