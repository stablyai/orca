import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  cloneLayoutNode,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { placedSplitRoot } from '../terminal-topology/terminal-pane-placement-graft'
import { tabRowPtyIdAfterLeafBinding } from './terminal-tab-pty-ownership'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'
import { reusedTerminalIdUnbinding } from './reused-terminal-id-unbind'

export function applyPtyBinding(
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string
): void {
  const reconciledIncarnation =
    args.expectedBinding !== undefined && args.incarnationId !== args.expectedBinding.incarnationId
  let terminalMembershipChanged = false
  const advanceTopologyFence = (): void => {
    const repoId = getRepoIdFromWorktreeId(bindingWorktreeId)
    const currentRevision = session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
    // A split establishes authority immediately, even before the first topology revision.
    const establishesMembershipAuthority = args.expectedSourceBinding !== undefined
    if (
      !reconciledIncarnation &&
      (!terminalMembershipChanged || (currentRevision <= 0 && !establishesMembershipAuthority))
    ) {
      return
    }
    // Host membership/incarnation changes must outrank stale renderer snapshots.
    session.terminalTopologyRevisionByRepoId = {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: currentRevision + 1
    }
  }
  // Unbind reused local IDs in the same commit that publishes the new incarnation.
  const unbound =
    ORCA_LAYOUT_OWNER_IS_MAIN && args.incarnationId
      ? reusedTerminalIdUnbinding(session, { ...args, incarnationId: args.incarnationId })
      : null
  const stamps =
    unbound?.terminalPtyIncarnationsByPaneKey ?? session.terminalPtyIncarnationsByPaneKey
  const { [paneKey]: recordedIncarnation, ...otherIncarnations } = stamps ?? {}
  if (args.incarnationId || (args.dropsIncarnation && recordedIncarnation)) {
    session.terminalPtyIncarnationsByPaneKey = args.incarnationId
      ? { ...stamps, [paneKey]: args.incarnationId }
      : otherIncarnations
  }
  if (args.incarnationId && session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
    session.terminalSurfaceTombstonesByPaneKey = {
      ...session.terminalSurfaceTombstonesByPaneKey
    }
    delete session.terminalSurfaceTombstonesByPaneKey[paneKey]
  }
  let rows = unbound?.tabsByWorktree ?? session.tabsByWorktree
  let layoutsByTab = unbound?.terminalLayoutsByTabId ?? session.terminalLayoutsByTabId
  const tabs = rows?.[bindingWorktreeId]
  const tab = tabs?.find((t) => t.id === args.tabId)
  if (tab) {
    if (args.correctStartupCwd !== undefined) {
      tab.startupCwd = args.correctStartupCwd
    }
    tab.ptyId = tabRowPtyIdAfterLeafBinding(
      tab,
      layoutsByTab?.[args.tabId]?.ptyIdsByLeafId,
      args.leafId,
      args.ptyId
    )
  } else {
    terminalMembershipChanged = true
    // Persist spawn-created tabs before delayed renderer saves to keep their bindings from becoming orphans.
    const nextTabs = [
      ...(tabs ?? []),
      createMinimalPersistedTerminalTab({
        ...args,
        worktreeId: bindingWorktreeId,
        existingTabCount: tabs?.length ?? 0
      })
    ]
    rows = { ...rows, [bindingWorktreeId]: nextTabs }
    session.activeWorktreeId ??= bindingWorktreeId
    session.activeTabId ??= args.tabId
    session.activeTabIdByWorktree = {
      ...session.activeTabIdByWorktree,
      [bindingWorktreeId]: session.activeTabIdByWorktree?.[bindingWorktreeId] ?? args.tabId
    }
  }
  session.tabsByWorktree = rows
  // Host-initiated binds must set the write-once default-terminal guard too.
  session.defaultTerminalTabsAppliedByWorktreeId = {
    ...session.defaultTerminalTabsAppliedByWorktreeId,
    [bindingWorktreeId]: true
  }
  // Acknowledged spawns must survive a crash before the renderer records their activity.
  if (
    session.activeWorktreeIdsOnShutdown &&
    !session.activeWorktreeIdsOnShutdown.includes(bindingWorktreeId)
  ) {
    session.activeWorktreeIdsOnShutdown = [
      ...session.activeWorktreeIdsOnShutdown,
      bindingWorktreeId
    ]
  }
  // Durable pane maps use UUID leaf keys; exclude legacy renderer-local IDs.
  const leafKeyed = isTerminalLeafId(args.leafId)
  const layout = layoutsByTab?.[args.tabId]
  if (leafKeyed && layout) {
    if (!layout.root) {
      terminalMembershipChanged = true
      layout.root = { type: 'leaf', leafId: args.leafId }
      layout.activeLeafId = args.leafId
      layout.expandedLeafId = null
    } else if (!layoutContainsLeafId(layout.root, args.leafId)) {
      terminalMembershipChanged = true
      // Persist minimal split membership before renderer saves so crashes cannot strand the new binding.
      // With main-owned layout, preserve the split position supplied by the window.
      layout.root = (ORCA_LAYOUT_OWNER_IS_MAIN &&
        placedSplitRoot(layout.root, args.leafId, args.placement)) || {
        type: 'split',
        direction: 'vertical',
        first: cloneLayoutNode(layout.root),
        second: { type: 'leaf', leafId: args.leafId }
      }
      layout.activeLeafId = args.leafId
      if (layout.expandedLeafId && !layoutContainsLeafId(layout.root, layout.expandedLeafId)) {
        layout.expandedLeafId = null
      }
    }
    layout.ptyIdsByLeafId = {
      ...layout.ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  } else if (leafKeyed) {
    terminalMembershipChanged = true
    // First spawns need a minimal durable layout before renderer snapshots arrive.
    layoutsByTab = {
      ...layoutsByTab,
      [args.tabId]: {
        root: { type: 'leaf', leafId: args.leafId },
        activeLeafId: args.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [args.leafId]: args.ptyId }
      }
    }
  }
  session.terminalLayoutsByTabId = layoutsByTab
  advanceTopologyFence()
}
