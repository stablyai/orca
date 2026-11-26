import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceLayoutLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { isPaneSleepRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CrewRelevance } from './crew-changes'
import { locateCrewWorktrees, type CrewWorktreeLocations } from './crew-workspace-names'

/** mainTerminalSourceInputs for the worktrees, tabs and panes crew rows show, so a write elsewhere reads nothing else. */
export function crewTopologyInputs(
  session: WorkspaceSessionState | null | undefined,
  context: WorkspaceLayoutLoadContext,
  scope: Pick<CrewRelevance, 'tabs' | 'sessions' | 'panes'>,
  located: CrewWorktreeLocations
) {
  if (!session) {
    return null
  }
  const worktrees = locateCrewWorktrees(session, scope, located)
  const pick = <T>(byKey: Record<string, T> | undefined, keys: Iterable<string>) => {
    const picked: [string, T][] = []
    for (const key of keys) {
      const value = byKey?.[key]
      if (value !== undefined) {
        picked.push([key, value])
      }
    }
    return picked
  }
  const tabIds = worktrees.flatMap((id) =>
    (session.tabsByWorktree?.[id] ?? []).map((tab) => tab.id)
  )
  return structuredClone({
    tabs: worktrees.map((key) => [
      key,
      (session.tabsByWorktree?.[key] ?? []).map((row) => [
        row.id,
        row.worktreeId,
        row.ptyId,
        row.sortOrder,
        row.createdAt
      ])
    ]),
    tabBar: worktrees.map((key) => [
      key,
      (session.unifiedTabs?.[key] ?? []).map((row) => [
        row.id,
        row.contentType,
        row.entityId,
        row.groupId,
        row.sortOrder,
        row.createdAt
      ])
    ]),
    groups: worktrees.map((key) => [
      key,
      (session.tabGroups?.[key] ?? []).map((group) => [group.id, group.tabOrder])
    ]),
    groupLayouts: pick(session.tabGroupLayouts, worktrees),
    layouts: pick(session.terminalLayoutsByTabId, tabIds).map(([id, layout]) => {
      const leaves = collectLayoutLeafIdsInOrder(layout.root)
      return [
        id,
        leaves,
        layout.ptyIdsByLeafId,
        leaves.map((leaf) => [leaf, context.ptyGenerationOf?.(leaf)])
      ]
    }),
    incarnations: pick(session.terminalPtyIncarnationsByPaneKey, scope.panes),
    sleeping: pick(session.sleepingAgentSessionsByPaneKey, scope.panes).map(([key, record]) => [
      key,
      isPaneSleepRecord(record)
    ]),
    retired: pick(session.terminalSurfaceTombstonesByPaneKey, scope.panes),
    closedTabs: pick(session.closedTerminalTabTombstonesByTabId, scope.tabs),
    closedPanes: pick(session.closedTerminalPanesByPaneKey, scope.panes)
  })
}
