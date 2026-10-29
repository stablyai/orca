import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  cloneLayoutNode,
  normalizeTerminalLayoutSnapshotForPersistence,
  layoutContainsLeafId
} from '../restoring-sessions/terminal-layout-normalization'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { placedSplitRoot } from '../terminal-topology/terminal-pane-placement-graft'
import { tabRowPtyIdAfterLeafBinding } from './terminal-tab-pty-ownership'
import type { PersistPtyBindingArgs } from './pty-binding-args'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { reduceReusedTerminalBinding } from './reused-terminal-id-unbind'

export function applyPtyBinding(
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string
): WorkspaceSessionState {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  reducePtyBinding(reader, args, bindingWorktreeId, paneKey)
  return reader.snapshot()
}

export function reducePtyBinding(
  reader: SessionUnitReader,
  args: PersistPtyBindingArgs,
  bindingWorktreeId: string,
  paneKey: string
): void {
  const reconciledIncarnation =
    args.expectedBinding !== undefined && args.incarnationId !== args.expectedBinding.incarnationId
  let terminalMembershipChanged = false
  const advanceTopologyFence = (): void => {
    const repoId = getRepoIdFromWorktreeId(bindingWorktreeId)
    const currentRevision = reader.unit('terminalTopologyRevisionByRepoId', repoId).value ?? 0
    // A split establishes authority immediately, even before the first topology revision.
    const establishesMembershipAuthority = args.expectedSourceBinding !== undefined
    if (
      !reconciledIncarnation &&
      (!terminalMembershipChanged || (currentRevision <= 0 && !establishesMembershipAuthority))
    ) {
      return
    }
    // Host membership/incarnation changes must outrank stale renderer snapshots.
    reader.write('terminalTopologyRevisionByRepoId', repoId, {
      present: true,
      value: currentRevision + 1
    })
  }
  if (ORCA_LAYOUT_OWNER_IS_MAIN && args.incarnationId) {
    reduceReusedTerminalBinding(reader, { ...args, incarnationId: args.incarnationId })
  }
  const recordedIncarnation = reader.unit('terminalPtyIncarnationsByPaneKey', paneKey).value
  if (args.incarnationId || (args.dropsIncarnation && recordedIncarnation)) {
    reader.write(
      'terminalPtyIncarnationsByPaneKey',
      paneKey,
      args.incarnationId
        ? { present: true, value: args.incarnationId }
        : { present: false, value: undefined }
    )
    reader.reconcileField('terminalPtyIncarnationsByPaneKey', {
      kind: 'replacement',
      present: true,
      explicitEmpty: true
    })
  }
  if (args.incarnationId && reader.unit('terminalSurfaceTombstonesByPaneKey', paneKey).present) {
    reader.write('terminalSurfaceTombstonesByPaneKey', paneKey, {
      present: false,
      value: undefined
    })
  }
  const tabs = reader.unit('tabsByWorktree', bindingWorktreeId).value
  const previousTab = tabs?.find((t) => t.id === args.tabId)
  const tab = previousTab ? { ...previousTab } : undefined
  if (tab) {
    if (args.correctStartupCwd !== undefined) {
      tab.startupCwd = args.correctStartupCwd
    }
    tab.ptyId = tabRowPtyIdAfterLeafBinding(
      tab,
      reader.unit('terminalLayoutsByTabId', args.tabId).value?.ptyIdsByLeafId,
      args.leafId,
      args.ptyId
    )
    reader.write('tabsByWorktree', bindingWorktreeId, {
      present: true,
      value: (tabs ?? []).map((row) => (row === previousTab ? tab : row))
    })
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
    reader.write('tabsByWorktree', bindingWorktreeId, { present: true, value: nextTabs })
    if (reader.field('activeWorktreeId').value == null) {
      reader.replace('activeWorktreeId', { present: true, value: bindingWorktreeId })
    }
    if (reader.field('activeTabId').value == null) {
      reader.replace('activeTabId', { present: true, value: args.tabId })
    }
    reader.write('activeTabIdByWorktree', bindingWorktreeId, {
      present: true,
      value: reader.unit('activeTabIdByWorktree', bindingWorktreeId).value ?? args.tabId
    })
  }
  reader.write('defaultTerminalTabsAppliedByWorktreeId', bindingWorktreeId, {
    present: true,
    value: true
  })
  const reconnect = reader.field('activeWorktreeIdsOnShutdown')
  if (reconnect.value && !reconnect.value.includes(bindingWorktreeId)) {
    reader.replace('activeWorktreeIdsOnShutdown', {
      present: true,
      value: [...reconnect.value, bindingWorktreeId]
    })
  }
  // Durable pane maps use UUID leaf keys; exclude legacy renderer-local IDs.
  const leafKeyed = isTerminalLeafId(args.leafId)
  const previousLayout = reader.unit('terminalLayoutsByTabId', args.tabId).value
  let layout = previousLayout ? { ...previousLayout } : undefined
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
    layout = {
      root: { type: 'leaf', leafId: args.leafId },
      activeLeafId: args.leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [args.leafId]: args.ptyId }
    }
  }
  const writtenLayout = layout
  if (writtenLayout) {
    const canonical = normalizeTerminalLayoutSnapshotForPersistence(writtenLayout).snapshot
    reader.write('terminalLayoutsByTabId', args.tabId, { present: true, value: canonical })
  }
  advanceTopologyFence()
}
