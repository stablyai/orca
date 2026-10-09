import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  cloneLayoutNode,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { tabRowPtyIdAfterLeafBinding } from './terminal-tab-pty-ownership'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'

export function applyPtyBinding(
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string
): void {
  const reconciledIncarnation =
    args.expectedBinding !== undefined && args.incarnationId !== args.expectedBinding.incarnationId
  let terminalMembershipChanged = false
  let hostAdmittedTabCreated = false
  const advanceTopologyFence = (): void => {
    const repoId = getRepoIdFromWorktreeId(bindingWorktreeId)
    const currentRevision = session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
    // Why: a split, or a host-admitted tab the renderer has never seen, is itself
    // the authority — with no fence the renderer's pre-create tab list replays
    // over it and the tab is lost even on the repo's first such change.
    const establishesMembershipAuthority =
      args.expectedSourceBinding !== undefined || hostAdmittedTabCreated
    if (
      !reconciledIncarnation &&
      (!terminalMembershipChanged || (currentRevision <= 0 && !establishesMembershipAuthority))
    ) {
      return
    }
    // Why: host-admitted membership or incarnation changes must outrank a stale renderer replay.
    session.terminalTopologyRevisionByRepoId = {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: currentRevision + 1
    }
  }
  if (args.incarnationId) {
    session.terminalPtyIncarnationsByPaneKey = {
      ...session.terminalPtyIncarnationsByPaneKey,
      [paneKey]: args.incarnationId
    }
    if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
      session.terminalSurfaceTombstonesByPaneKey = {
        ...session.terminalSurfaceTombstonesByPaneKey
      }
      delete session.terminalSurfaceTombstonesByPaneKey[paneKey]
    }
  }
  const tabs = session.tabsByWorktree?.[bindingWorktreeId]
  const tab = tabs?.find((t) => t.id === args.tabId)
  if (tab) {
    tab.ptyId = tabRowPtyIdAfterLeafBinding(
      tab,
      session.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId,
      args.leafId,
      args.ptyId
    )
  } else {
    terminalMembershipChanged = true
    hostAdmittedTabCreated = args.hostAdmittedMembership === true
    // Why: pty:spawn can beat the debounced writer; persist a minimal tab so hydration won't prune the binding as orphaned.
    const nextTabs = [
      ...(tabs ?? []),
      createMinimalPersistedTerminalTab({
        ...args,
        worktreeId: bindingWorktreeId,
        existingTabCount: tabs?.length ?? 0
      })
    ]
    session.tabsByWorktree = {
      ...session.tabsByWorktree,
      [bindingWorktreeId]: nextTabs
    }
    session.activeWorktreeId ??= bindingWorktreeId
    session.activeTabId ??= args.tabId
    session.activeTabIdByWorktree = {
      ...session.activeTabIdByWorktree,
      [bindingWorktreeId]: session.activeTabIdByWorktree?.[bindingWorktreeId] ?? args.tabId
    }
  }
  // Why: host-initiated persist snapshots used to omit this write-once guard, so every launch or reattach treated the worktree as never having default terminals applied.
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
  if (!isTerminalLeafId(args.leafId)) {
    // Why: keep legacy renderer-local pane ids out of durable leaf-keyed layout state after the UUID migration.
    advanceTopologyFence()
    return
  }
  const layout = session.terminalLayoutsByTabId?.[args.tabId]
  if (layout) {
    if (!layout.root) {
      terminalMembershipChanged = true
      // Why: createTab can persist an empty layout before TerminalPane mounts; the sync binding still needs a durable root.
      layout.root = { type: 'leaf', leafId: args.leafId }
      layout.activeLeafId = args.leafId
      layout.expandedLeafId = null
    } else if (!layoutContainsLeafId(layout.root, args.leafId)) {
      terminalMembershipChanged = true
      // Why: splitPane spawns before its snapshot reaches main; add a minimal leaf so a crash can't strand the pane's binding.
      layout.root = {
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
  } else {
    terminalMembershipChanged = true
    // Why: first tab spawn — persist a minimal layout so a SIGKILL before the renderer snapshot can't lose ptyIdsByLeafId.
    session.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [args.tabId]: {
        root: { type: 'leaf', leafId: args.leafId },
        activeLeafId: args.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [args.leafId]: args.ptyId }
      }
    }
  }
  advanceTopologyFence()
}
