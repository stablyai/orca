import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import type { PtyBindingSourceExpectation } from './store'

export type PtyBindingRefusalRequest = {
  tabId: string
  leafId: string
  expectedBinding?: { ptyId: string; incarnationId?: string }
  expectedSourceBinding?: PtyBindingSourceExpectation
  mayCreate?: boolean
  mayReviveRetiredSurface?: boolean
}

/**
 * The four fences a binding must clear before anything is mutated, so a refusal leaves nothing
 * half-written. Order matters: every `false` here is returned before the write path or the
 * fast lane can run, which is what the relay's lease expiry and the stable-owner throw rely on.
 */
export function ptyBindingIsRefused(
  args: PtyBindingRefusalRequest,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string
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
  // Mirrors the four creating branches of the write path — mint a tab, mint a root leaf, split
  // the root and graft a leaf, mint a layout — each of which sets `terminalMembershipChanged`.
  if (
    args.mayReviveRetiredSurface === false &&
    session.terminalSurfaceTombstonesByPaneKey?.[paneKey]
  ) {
    return true
  }
  if (args.mayCreate === false) {
    const existingTab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
      (candidate) => candidate.id === args.tabId
    )
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
