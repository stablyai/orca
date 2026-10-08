import { parsePaneKey } from '../../shared/stable-pane-id'
import { getPinnedClaudeAccountIdForPty } from './claude-pinned-pty-registry'

type PersistedTerminalLayouts = Record<
  string,
  { ptyIdsByLeafId?: Record<string, string> } | undefined
>

export type PinnedClaudePaneLookup = {
  getLivePtyIdForPaneKey: (paneKey: string) => string | undefined
  getPersistedTerminalLayouts: () => PersistedTerminalLayouts | undefined
}

/** The managed account the pane's Claude PTY is pinned to; undefined for unpinned, SSH and unknown panes. */
export function pinnedClaudeAccountIdForPane(
  row: { paneKey: string; connectionId?: string | null },
  lookup: PinnedClaudePaneLookup
): string | undefined {
  if (row.connectionId) {
    return undefined
  }
  const livePtyId = lookup.getLivePtyIdForPaneKey(row.paneKey)
  if (livePtyId) {
    return getPinnedClaudeAccountIdForPty(livePtyId)
  }
  // Why: after a restart the renderer pulls the status snapshot before a restored pane reattaches,
  // so only the persisted layout can name the surviving PTY at that point.
  const pane = parsePaneKey(row.paneKey)
  const persistedPtyId = pane
    ? lookup.getPersistedTerminalLayouts()?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
    : undefined
  return persistedPtyId ? getPinnedClaudeAccountIdForPty(persistedPtyId) : undefined
}

export function withPinnedClaudeAccount<
  T extends { paneKey: string; connectionId?: string | null }
>(row: T, lookup: PinnedClaudePaneLookup): T & { claudeAccountId?: string } {
  const claudeAccountId = pinnedClaudeAccountIdForPane(row, lookup)
  return claudeAccountId ? { ...row, claudeAccountId } : row
}
