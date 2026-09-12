import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import { cloneWorkspaceSessionState } from '../restoring-sessions/session-owner-fields'
import type { PtyOwnershipTransferBindingAdmission } from './pty-ownership-transfer-binding-admission'
import { inspectReservedPtyOwnershipTransferLayoutAdmission } from './pty-ownership-transfer-reserved-layout-admission'
import type { StoreRuntimeState } from './store-runtime-state'
import type { PtyBindingPersistenceOperations } from './pty-binding-persistence'

export function persistReservedPtyOwnershipTransferLayout(
  runtime: Pick<StoreRuntimeState, 'state' | 'flushOrThrow'>,
  args: Parameters<PtyBindingPersistenceOperations['persistPtyBinding']>[0],
  hostId: string
): boolean {
  const reservation = args.reservedTransferLayout
  const snapshotRef = args.scrollbackSnapshotRef
  if (
    !reservation ||
    hostId !== 'local' ||
    args.bindingMode !== 'strict-transfer-publication' ||
    args.expectedBinding ||
    args.expectedSourceBinding ||
    args.startupCwd !== undefined ||
    !snapshotRef ||
    !/^v1-[0-9a-f]{32}$/.test(snapshotRef)
  ) {
    return false
  }
  const binding: PtyOwnershipTransferBindingAdmission = {
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    ptyId: args.ptyId,
    incarnationId: args.incarnationId
  }
  const previous = runtime.state.workspaceSession
  if (args.mayCreate === false && !previous.terminalLayoutsByTabId[binding.tabId]) {
    return false
  }
  const admission = inspectReservedPtyOwnershipTransferLayoutAdmission(
    previous,
    binding,
    reservation
  )
  if (admission === 'conflict') {
    return false
  }
  if (admission === 'published') {
    if (
      previous.terminalLayoutsByTabId[binding.tabId]?.scrollbackRefsByLeafId?.[binding.leafId] !==
      snapshotRef
    ) {
      return false
    }
    runtime.flushOrThrow()
    return true
  }
  const repoId = getRepoIdFromWorktreeId(binding.worktreeId)
  const revision = previous.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    return false
  }
  const next = cloneWorkspaceSessionState(previous)
  const tabs = next.tabsByWorktree[binding.worktreeId] ?? []
  let tab = tabs.find((entry) => entry.id === binding.tabId)
  if (!tab) {
    tab = structuredClone(reservation.tab)
    next.tabsByWorktree[binding.worktreeId] = [...tabs, tab]
  }
  const layout = next.terminalLayoutsByTabId[binding.tabId] ?? structuredClone(reservation.layout)
  next.terminalLayoutsByTabId[binding.tabId] = layout
  layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [binding.leafId]: binding.ptyId }
  layout.scrollbackRefsByLeafId = {
    ...layout.scrollbackRefsByLeafId,
    [binding.leafId]: snapshotRef
  }
  next.terminalPtyIncarnationsByPaneKey = {
    ...next.terminalPtyIncarnationsByPaneKey,
    [`${binding.tabId}:${binding.leafId}`]: binding.incarnationId!
  }
  const firstLeaf = collectLayoutLeafIdsInOrder(reservation.layout.root)[0]
  tab.ptyId = layout.ptyIdsByLeafId[firstLeaf] ?? null
  // Every newly published host binding must outrank stale renderer session snapshots.
  next.terminalTopologyRevisionByRepoId = {
    ...next.terminalTopologyRevisionByRepoId,
    [repoId]: revision + 1
  }
  if (
    inspectReservedPtyOwnershipTransferLayoutAdmission(next, binding, reservation) !== 'published'
  ) {
    return false
  }
  runtime.state.workspaceSession = next
  try {
    runtime.flushOrThrow()
  } catch (error) {
    runtime.state.workspaceSession = previous
    throw error
  }
  return true
}
