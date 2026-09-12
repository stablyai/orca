import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

export type PtyOwnershipTransferBindingAdmission = Readonly<{
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}>

export type PtyOwnershipTransferBindingAdmissionState = 'absent' | 'published' | 'conflict'

type TabClaim = Readonly<{
  ownerWorktreeId: string
  tabWorktreeId: string
  ptyId: string | null
}>

function collectTabClaims(session: WorkspaceSessionState, tabId: string): readonly TabClaim[] {
  return Object.entries(session.tabsByWorktree).flatMap(([ownerWorktreeId, tabs]) =>
    tabs
      .filter((tab) => tab.id === tabId)
      .map((tab) => ({
        ownerWorktreeId,
        tabWorktreeId: tab.worktreeId,
        ptyId: tab.ptyId
      }))
  )
}

function hasConflictingLeafOrPtyClaim(
  session: WorkspaceSessionState,
  binding: PtyOwnershipTransferBindingAdmission,
  exactSurfacePublished: boolean
): boolean {
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
    const topologyLeafIds = collectLayoutLeafIdsInOrder(layout.root)
    const leafIds = new Set([...topologyLeafIds, ...Object.keys(layout.ptyIdsByLeafId ?? {})])
    for (const leafId of leafIds) {
      const exactSurface = tabId === binding.tabId && leafId === binding.leafId
      if (
        (leafId === binding.leafId || layout.ptyIdsByLeafId?.[leafId] === binding.ptyId) &&
        !(exactSurfacePublished && exactSurface)
      ) {
        return true
      }
    }
    if (
      tabId === binding.tabId &&
      topologyLeafIds.filter((leafId) => leafId === binding.leafId).length !==
        (exactSurfacePublished ? 1 : 0)
    ) {
      return true
    }
  }
  return false
}

function hasConflictingIncarnationClaim(
  session: WorkspaceSessionState,
  binding: PtyOwnershipTransferBindingAdmission,
  exactSurfacePublished: boolean
): boolean {
  const paneKey = `${binding.tabId}:${binding.leafId}`
  return Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).some(
    ([candidatePaneKey, incarnationId]) =>
      (candidatePaneKey === paneKey || incarnationId === binding.incarnationId) &&
      !(
        exactSurfacePublished &&
        candidatePaneKey === paneKey &&
        incarnationId === binding.incarnationId
      )
  )
}

function hasConflictingLegacyPtyClaim(
  session: WorkspaceSessionState,
  binding: PtyOwnershipTransferBindingAdmission,
  exactSurfacePublished: boolean
): boolean {
  return Object.entries(session.tabsByWorktree).some(([ownerWorktreeId, tabs]) =>
    tabs.some(
      (tab) =>
        tab.ptyId === binding.ptyId &&
        !(
          exactSurfacePublished &&
          ownerWorktreeId === binding.worktreeId &&
          tab.id === binding.tabId
        )
    )
  )
}

function hasConflictingTombstone(
  session: WorkspaceSessionState,
  binding: PtyOwnershipTransferBindingAdmission
): boolean {
  const paneKey = `${binding.tabId}:${binding.leafId}`
  return Object.entries(session.terminalSurfaceTombstonesByPaneKey ?? {}).some(
    ([candidatePaneKey, tombstone]) =>
      candidatePaneKey === paneKey ||
      tombstone.leafId === binding.leafId ||
      tombstone.ptyId === binding.ptyId ||
      tombstone.incarnationId === binding.incarnationId
  )
}

export function inspectPtyOwnershipTransferBindingAdmission(
  session: WorkspaceSessionState,
  binding: PtyOwnershipTransferBindingAdmission
): PtyOwnershipTransferBindingAdmissionState {
  if (!binding.incarnationId || !isTerminalLeafId(binding.leafId)) {
    return 'conflict'
  }
  const paneKey = `${binding.tabId}:${binding.leafId}`
  const tabClaims = collectTabClaims(session, binding.tabId)
  const layout = session.terminalLayoutsByTabId[binding.tabId]
  const topologyLeafIds = layout ? collectLayoutLeafIdsInOrder(layout.root) : []
  const ptyBindings = Object.entries(layout?.ptyIdsByLeafId ?? {})
  const exactSurfacePublished =
    tabClaims.length === 1 &&
    tabClaims[0]?.ownerWorktreeId === binding.worktreeId &&
    tabClaims[0]?.tabWorktreeId === binding.worktreeId &&
    tabClaims[0]?.ptyId === binding.ptyId &&
    topologyLeafIds.length === 1 &&
    topologyLeafIds[0] === binding.leafId &&
    ptyBindings.length === 1 &&
    ptyBindings[0]?.[0] === binding.leafId &&
    ptyBindings[0]?.[1] === binding.ptyId &&
    session.terminalPtyIncarnationsByPaneKey?.[paneKey] === binding.incarnationId

  if (
    hasConflictingTombstone(session, binding) ||
    hasConflictingLeafOrPtyClaim(session, binding, exactSurfacePublished) ||
    hasConflictingIncarnationClaim(session, binding, exactSurfacePublished) ||
    hasConflictingLegacyPtyClaim(session, binding, exactSurfacePublished)
  ) {
    return 'conflict'
  }
  if (exactSurfacePublished) {
    return 'published'
  }
  return tabClaims.length === 0 && layout === undefined ? 'absent' : 'conflict'
}
