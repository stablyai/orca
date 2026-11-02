import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { TerminalSessionPartition } from '../../../shared/workspace-layout/terminal-owner-invariants'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import type { PtyBindingSourceExpectation } from './store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { isClosedPaneFenced } from '../terminal-topology/closed-pane-binding-fence'

export type PtyBindingRefusalRequest = {
  tabId: string
  leafId: string
  expectedBinding?: { ptyId: string; incarnationId?: string }
  expectedSourceBinding?: PtyBindingSourceExpectation
  mayCreate?: boolean
  mayReviveRetiredSurface?: boolean
}

/** Refuse before fast-lane checks or mutation so relay expiry/stable-owner failures leave no partial edit. */
export function ptyBindingIsRefused(
  args: PtyBindingRefusalRequest,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string,
  /** Inspect all partitions: older relay reattaches may have left SSH panes in local. */
  partitions: readonly TerminalSessionPartition[]
): boolean {
  if (args.expectedSourceBinding) {
    const expected = args.expectedSourceBinding
    if (expected.tabId !== args.tabId) {
      return true
    }
    const sourceTab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
      (candidate) => candidate.id === expected.tabId && candidate.worktreeId === bindingWorktreeId
    )
    const sourceLayout = session.terminalLayoutsByTabId?.[expected.tabId]
    const sourcePaneKey = `${expected.tabId}:${expected.leafId}`
    if (
      !sourceTab ||
      sourceLayout?.ptyIdsByLeafId?.[expected.leafId] !== expected.ptyId ||
      !layoutContainsLeafId(sourceLayout.root, expected.leafId) ||
      (expected.incarnationId !== undefined &&
        session.terminalPtyIncarnationsByPaneKey?.[sourcePaneKey] !== expected.incarnationId)
    ) {
      return true
    }
  }
  if (args.expectedBinding) {
    const tab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
      (candidate) => candidate.id === args.tabId && candidate.worktreeId === bindingWorktreeId
    )
    const boundPtyId = session.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
    if (
      !tab ||
      boundPtyId !== args.expectedBinding.ptyId ||
      session.terminalPtyIncarnationsByPaneKey?.[paneKey] !== args.expectedBinding.incarnationId
    ) {
      return true
    }
  }
  const existingTab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
    (candidate) => candidate.id === args.tabId
  )
  // Closed-tab spawns can commit after restart; UUID tombstones prevent resurrection.
  if (
    !existingTab &&
    partitions.some((partition) =>
      hasClosedTerminalTabRecord(partition.session.closedTerminalTabTombstonesByTabId, args.tabId)
    )
  ) {
    return true
  }
  // An in-flight start must not recreate a pane main already closed or withdrew.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !layoutContainsLeafId(
      session.terminalLayoutsByTabId?.[args.tabId]?.root ?? null,
      args.leafId
    ) &&
    isClosedPaneFenced(paneKey)
  ) {
    return true
  }
  // Fence all membership-creating branches, including split-leaf grafts.
  if (
    args.mayReviveRetiredSurface === false &&
    session.terminalSurfaceTombstonesByPaneKey?.[paneKey]
  ) {
    return true
  }
  if (args.mayCreate === false) {
    const existingLayout = session.terminalLayoutsByTabId?.[args.tabId]
    const wouldCreateTopology =
      !existingTab ||
      (isTerminalLeafId(args.leafId) &&
        (!existingLayout ||
          !existingLayout.root ||
          !layoutContainsLeafId(existingLayout.root, args.leafId)))
    if (wouldCreateTopology) {
      return true
    }
  }
  return false
}
