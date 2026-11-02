import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  readCanonicalPtyOwners,
  resolveCanonicalPtyClaim
} from '../../shared/workspace-layout/legacy-terminal-row-claims'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds,
  deriveHeadlessLegacyTerminalLeafId,
  isPersistedTerminalLeafActive
} from './mobile-session-layout-projection'

/**
 * Drops a legacy row with no tab-bar entry whose every terminal a tab-bar tab of this workspace
 * holds (the shared Loader's rule; the window hides it too), and moves a selection on it to that tab.
 */
function withoutAbsorbedLegacyRows(
  worktreeId: string,
  persistedTabs: readonly TerminalTab[],
  session: WorkspaceSessionState
): { rows: TerminalTab[]; selection: WorkspaceSessionState } {
  const canonical = readCanonicalPtyOwners(session, worktreeId, persistedTabs)
  const canonicalTabIdByAbsorbedTabId = new Map<string, string>()
  const rows = persistedTabs.filter((row) => {
    const claim = resolveCanonicalPtyClaim(session, row, canonical)
    if (claim.kind === 'subsumed') {
      canonicalTabIdByAbsorbedTabId.set(row.id, claim.canonicalTabId)
    }
    return claim.kind !== 'subsumed'
  })
  const activeTabId = session.activeTabIdByWorktree?.[worktreeId] ?? session.activeTabId
  const followed = activeTabId ? canonicalTabIdByAbsorbedTabId.get(activeTabId) : undefined
  const selection = followed
    ? {
        ...session,
        activeTabIdByWorktree: { ...session.activeTabIdByWorktree, [worktreeId]: followed }
      }
    : session
  return { rows, selection }
}

export function buildHeadlessMobileSessionTerminalTabs(
  worktreeId: string,
  persistedTabs: readonly TerminalTab[],
  session: WorkspaceSessionState
): RuntimeMobileSessionTerminalTab[] {
  const { rows, selection } = withoutAbsorbedLegacyRows(worktreeId, persistedTabs, session)
  return rows
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .flatMap((tab, index) => {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      const leafIds = collectPersistedTerminalLeafIds(layout)
      if (leafIds.length === 0) {
        leafIds.push(deriveHeadlessLegacyTerminalLeafId(tab.id))
      }
      return leafIds.flatMap((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null)
        const title =
          tab.customTitle?.trim() ||
          tab.generatedTitle?.trim() ||
          tab.title?.trim() ||
          tab.defaultTitle?.trim() ||
          `Terminal ${index + 1}`
        return [
          {
            type: 'terminal' as const,
            id: `${tab.id}::${leafId}`,
            parentTabId: tab.id,
            leafId,
            title,
            customTitle: tab.customTitle?.trim() || null,
            ...(ptyId ? { ptyId } : {}),
            ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
            ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {}),
            ...(layout ? { parentLayout: cloneTerminalLayoutSnapshot(layout) } : {}),
            ...(tab.color != null ? { color: tab.color } : {}),
            ...(tab.isPinned ? { isPinned: true } : {}),
            ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
            isActive: isPersistedTerminalLeafActive(selection, worktreeId, tab.id, leafId, layout)
          }
        ]
      })
    })
}
