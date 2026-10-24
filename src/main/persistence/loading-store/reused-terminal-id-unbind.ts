// Layout-owner builds: a local terminal id is a counter, so after a restart a new terminal can reuse
// the id a saved pane still binds. The spawn commit that binds the new terminal also unbinds the id
// from every other pane stamped with a different incarnation, so main's layout names one pane.
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export type ReusedTerminalBinding = {
  ptyId: string
  incarnationId: string
  tabId: string
  leafId: string
}

type UnboundFields = Pick<
  WorkspaceSessionState,
  'terminalLayoutsByTabId' | 'terminalPtyIncarnationsByPaneKey' | 'tabsByWorktree'
>

/**
 * The session's layouts, incarnation stamps and tab rows with `ptyId` dropped from each other pane
 * whose stamped incarnation differs; null when none does. The commit writes them with its binding.
 * An unstamped binding (a legacy save) is left alone: nothing proves it names another process.
 */
export function reusedTerminalIdUnbinding(
  session: WorkspaceSessionState,
  binding: ReusedTerminalBinding
): UnboundFields | null {
  const stamps = session.terminalPtyIncarnationsByPaneKey ?? {}
  let layouts = session.terminalLayoutsByTabId
  let remainingStamps = stamps
  let rows = session.tabsByWorktree
  let changed = false
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const stale = Object.entries(layout.ptyIdsByLeafId ?? {}).flatMap(([leafId, ptyId]) => {
      const stamp = stamps[`${tabId}:${leafId}`]
      const isBindingPane = tabId === binding.tabId && leafId === binding.leafId
      return ptyId === binding.ptyId &&
        !isBindingPane &&
        stamp !== undefined &&
        stamp !== binding.incarnationId
        ? [`${tabId}:${leafId}`]
        : []
    })
    if (stale.length === 0) {
      continue
    }
    changed = true
    const stillBound = Object.fromEntries(
      Object.entries(layout.ptyIdsByLeafId ?? {}).filter(
        ([leafId]) => !stale.includes(`${tabId}:${leafId}`)
      )
    )
    layouts = { ...layouts, [tabId]: { ...layout, ptyIdsByLeafId: stillBound } }
    remainingStamps = Object.fromEntries(
      Object.entries(remainingStamps).filter(([paneKey]) => !stale.includes(paneKey))
    )
    // The tab row's own terminal id names the stale process too; it takes a pane still bound.
    const named = (tab: { id: string; ptyId?: string | null }) =>
      tab.id === tabId && tab.ptyId === binding.ptyId
    rows = Object.fromEntries(
      Object.entries(rows).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.some(named)
          ? tabs.map((tab) =>
              named(tab) ? { ...tab, ptyId: Object.values(stillBound)[0] ?? null } : tab
            )
          : tabs
      ])
    )
  }
  return changed
    ? {
        terminalLayoutsByTabId: layouts,
        terminalPtyIncarnationsByPaneKey: remainingStamps,
        tabsByWorktree: rows
      }
    : null
}
