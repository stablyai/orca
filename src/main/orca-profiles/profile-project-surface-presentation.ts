import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { TransferredSurfaceIdentity } from './profile-project-surface-transfer'

/** Presentation follows collision remaps; physical run, resource and provenance are never rewritten. */
export function remapProjectSurfacePresentation(
  session: WorkspaceSessionState,
  hostId: ExecutionHostId,
  identities: readonly TransferredSurfaceIdentity[]
): WorkspaceSessionState {
  const changed = identities.filter(
    ({ before, after }) =>
      before.hostTabId !== after.hostTabId ||
      (before.content?.kind === 'terminal' &&
        after.content?.kind === 'terminal' &&
        (before.content.entityId !== after.content.entityId ||
          Object.keys(before.content.leaves).some(
            (id) =>
              !after.content ||
              after.content.kind !== 'terminal' ||
              !Object.hasOwn(after.content.leaves, id)
          )))
  )
  if (!changed.length) {
    return session
  }
  const loaded = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
  for (const { before, after } of changed) {
    const workspace = loaded.layout.workspaces[before.workspaceId]
    const tab = workspace?.tabs.find((candidate) => candidate.id === before.hostTabId)
    if (!workspace || !tab) {
      continue
    }
    const mapTab = (id: string | null | undefined) =>
      id === before.hostTabId ? after.hostTabId : id
    tab.id = after.hostTabId
    for (const group of workspace.groups) {
      group.tabOrder = group.tabOrder.map((id) => mapTab(id)!)
    }
    for (const group of Object.values(loaded.desktopView.groups[before.workspaceId] ?? {})) {
      group.activeTabId = mapTab(group.activeTabId) ?? null
      if (group.recentTabIds) {
        group.recentTabIds = group.recentTabIds.map((id) => mapTab(id)!)
      }
    }
    loaded.desktopView.activeTabId = mapTab(loaded.desktopView.activeTabId) ?? null
    if (loaded.desktopView.activeTabIdByWorktree) {
      const current = loaded.desktopView.activeTabIdByWorktree[before.workspaceId]
      if (current) {
        loaded.desktopView.activeTabIdByWorktree[before.workspaceId] = mapTab(current)!
      }
    }
    rekeyValue(
      loaded.desktopView.lastFocusedAt[before.workspaceId],
      before.hostTabId,
      after.hostTabId
    )
    rekeyValue(loaded.facts.tabLabels[before.workspaceId], before.hostTabId, after.hostTabId)
    if (
      tab.kind !== 'terminal' ||
      before.content?.kind !== 'terminal' ||
      after.content?.kind !== 'terminal'
    ) {
      continue
    }
    const oldEntity = before.content.entityId
    const newEntity = after.content.entityId
    const oldLeaves = collectLayoutLeafIdsInOrder(before.content.root)
    const newLeaves = collectLayoutLeafIdsInOrder(after.content.root)
    const leaves = new Map(oldLeaves.map((id, index) => [id, newLeaves[index]!]))
    const tree = (node: TerminalPaneLayoutNode | null): TerminalPaneLayoutNode | null =>
      !node
        ? null
        : node.type === 'leaf'
          ? { ...node, leafId: leaves.get(node.leafId) ?? node.leafId }
          : { ...node, first: tree(node.first)!, second: tree(node.second)! }
    tab.entityId = newEntity
    tab.panes.root = tree(tab.panes.root)
    if (tab.panes.chatLeafId) {
      tab.panes.chatLeafId = leaves.get(tab.panes.chatLeafId) ?? tab.panes.chatLeafId
    }
    const priorLeaves = { ...workspace.leaves }
    const priorScrollback = { ...loaded.facts.scrollback }
    for (const id of oldLeaves) {
      delete workspace.leaves?.[id]
    }
    for (const id of oldLeaves) {
      delete loaded.facts.scrollback[id]
    }
    for (const [oldId, newId] of leaves) {
      if (priorLeaves[oldId]) {
        ;(workspace.leaves ??= {})[newId] = priorLeaves[oldId]!
      }
      if (priorScrollback[oldId]) {
        loaded.facts.scrollback[newId] = priorScrollback[oldId]!
      }
    }
    const paneView = loaded.desktopView.panes[oldEntity]
    if (paneView) {
      delete loaded.desktopView.panes[oldEntity]
      loaded.desktopView.panes[newEntity] = {
        activeLeafId: leaves.get(paneView.activeLeafId ?? '') ?? paneView.activeLeafId,
        expandedLeafId: leaves.get(paneView.expandedLeafId ?? '') ?? paneView.expandedLeafId
      }
    }
    rekeyValue(loaded.facts.terminalRows, oldEntity, newEntity)
    rekeyValue(loaded.facts.localOnlyScrollbackByTabId, oldEntity, newEntity)
    const localBuffers = loaded.facts.localOnlyScrollbackByTabId?.[newEntity]
    if (localBuffers && loaded.facts.localOnlyScrollbackByTabId) {
      loaded.facts.localOnlyScrollbackByTabId[newEntity] = Object.fromEntries(
        Object.entries(localBuffers).map(([leafId, buffer]) => [
          leaves.get(leafId) ?? leafId,
          buffer
        ])
      )
    }
    if (loaded.carried.remoteSessionIdsByTabId?.[oldEntity] && oldEntity !== newEntity) {
      loaded.carried.remoteSessionIdsByTabId[newEntity] =
        loaded.carried.remoteSessionIdsByTabId[oldEntity]!
      delete loaded.carried.remoteSessionIdsByTabId[oldEntity]
    }
  }
  return { ...session, ...saveWorkspaceLayout(loaded) }
}

function rekeyValue<T>(
  rows: Record<string, T> | undefined,
  previousId: string,
  currentId: string
): void {
  if (rows && previousId !== currentId && Object.hasOwn(rows, previousId)) {
    rows[currentId] = rows[previousId]!
    delete rows[previousId]
  }
}
