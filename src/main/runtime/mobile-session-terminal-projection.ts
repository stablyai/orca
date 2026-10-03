import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds,
  deriveHeadlessLegacyTerminalLeafId,
  isPersistedTerminalLeafActive
} from './mobile-session-layout-projection'

export function buildHeadlessMobileSessionTerminalTabs(
  worktreeId: string,
  persistedTabs: readonly TerminalTab[],
  session: WorkspaceSessionState
): RuntimeMobileSessionTerminalTab[] {
  return [...persistedTabs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .flatMap((tab, index) => {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      const leafIds = collectPersistedTerminalLeafIds(layout)
      if (leafIds.length === 0) {
        leafIds.push(deriveHeadlessLegacyTerminalLeafId(tab.id))
      }
      return leafIds.flatMap((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null)
        // Why: the renderer omits a tab-wide custom title on every split leaf.
        // Copying the parent name here makes a headless rebuild rename them all.
        const singleLeaf = leafIds.length === 1
        const customTitle = singleLeaf ? tab.customTitle?.trim() || '' : ''
        const leafTitle = layout?.titlesByLeafId?.[leafId]?.trim() || ''
        const title = singleLeaf
          ? customTitle ||
            tab.generatedTitle?.trim() ||
            tab.title?.trim() ||
            tab.defaultTitle?.trim() ||
            `Terminal ${index + 1}`
          : leafTitle || 'Terminal'
        return [
          {
            type: 'terminal' as const,
            id: `${tab.id}::${leafId}`,
            parentTabId: tab.id,
            leafId,
            title,
            ...(customTitle ? { customTitle } : {}),
            ...(ptyId ? { ptyId } : {}),
            ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
            ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {}),
            ...(layout ? { parentLayout: cloneTerminalLayoutSnapshot(layout) } : {}),
            ...(tab.color != null ? { color: tab.color } : {}),
            ...(tab.isPinned ? { isPinned: true } : {}),
            ...(tab.viewMode ? { viewMode: tab.viewMode } : {}),
            isActive: isPersistedTerminalLeafActive(session, worktreeId, tab.id, leafId, layout)
          }
        ]
      })
    })
}
