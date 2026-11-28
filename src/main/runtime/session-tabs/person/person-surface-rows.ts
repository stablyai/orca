// A teammate's own terminals and files as their list's rows, and the host's list without any tab a
// teammate's list holds (teammate-rules.ts, rule 4).
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { detectLanguage } from '../../../../shared/editor-language/editor-language-detect'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { buildMaterializedHeadlessParentLayout } from '../../terminal/surface/mobile-session-layout-projection'
import { normalizeMobileSessionTabSelection } from '../layout/mobile-session-tab-selection'
import { personTabId, type PersonSurface } from './person-tab-list-snapshot'

/** A terminal's or file's row as it reads now; null while its terminal is not running here. A file
 *  reads from disk on whichever computer shows it. */
export function personSurfaceRow(
  worktreeId: string,
  surface: Exclude<PersonSurface, { kind: 'browser' }>,
  ptyOf: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
): RuntimeMobileSessionTerminalTab | RuntimeMobileSessionFileTab | null {
  if (surface.kind === 'file') {
    return {
      type: 'file',
      id: personTabId(surface),
      title: surface.relativePath.split(/[\\/]/).pop() || surface.relativePath,
      filePath: surface.filePath,
      relativePath: surface.relativePath,
      language: detectLanguage(surface.filePath),
      ...(surface.mode === 'diff'
        ? {
            mode: 'diff' as const,
            diffSource: surface.diffSource ?? 'unstaged',
            ...(surface.oldPath ? { oldPath: surface.oldPath } : {})
          }
        : { mode: 'edit' as const }),
      isDirty: false,
      isActive: false
    }
  }
  const pty = surface.ptyId ? ptyOf(surface.ptyId) : undefined
  if (!pty?.connected || pty.worktreeId !== worktreeId) {
    return null
  }
  return {
    type: 'terminal',
    id: personTabId(surface),
    title: pty.title || 'Terminal',
    // A name someone gave it (`terminal.rename`) shows over the program's title, as on host tabs.
    ...(pty.manualTitle ? { customTitle: pty.manualTitle } : {}),
    parentTabId: surface.parentTabId,
    leafId: surface.leafId,
    ptyId: pty.ptyId,
    incarnationId: pty.incarnationId,
    ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
    parentLayout: buildMaterializedHeadlessParentLayout(surface.leafId, pty.ptyId, undefined),
    isActive: false
  }
}

/** The snapshot without the tabs `held` names, from its groups too. */
export function withoutHeldTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  held: (tab: RuntimeMobileSessionSnapshotTab) => boolean
): RuntimeMobileSessionTabsSnapshot {
  const gone = snapshot.tabs.filter(held)
  if (gone.length === 0) {
    return snapshot
  }
  const goneIds = new Set(
    gone.flatMap((tab) =>
      tab.type === 'terminal'
        ? [tab.id, tab.parentTabId]
        : tab.type === 'browser'
          ? [tab.id, tab.browserWorkspaceId]
          : [tab.id]
    )
  )
  return normalizeMobileSessionTabSelection({
    ...snapshot,
    tabs: snapshot.tabs.filter((tab) => !gone.includes(tab)),
    ...(snapshot.tabGroups
      ? {
          tabGroups: snapshot.tabGroups.map((group) => ({
            ...group,
            tabOrder: group.tabOrder.filter((id) => !goneIds.has(id)),
            activeTabId:
              group.activeTabId && goneIds.has(group.activeTabId) ? null : group.activeTabId
          }))
        }
      : {})
  })
}
