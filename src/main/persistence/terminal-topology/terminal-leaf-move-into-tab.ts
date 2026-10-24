import { graftLeafBeside } from '../../../shared/terminal-layout-leaf-graft'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafIntoTabRefusal,
  type TerminalLeafIntoTabRequest,
  type TerminalLeafIntoTabResult
} from '../../../shared/terminal-leaf-move'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTerminalSurfaceInWorkspaceSession } from '../../runtime/terminal-surface-close'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import { leafHeldByOtherTab, moveRecordKey } from './terminal-leaf-move'
import {
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

export type PlannedLeafMoveIntoTab = {
  result: TerminalLeafIntoTabResult
  /** Every partition the plan rewrote; empty when nothing changes. */
  sessions: TerminalSessionPartition[]
  /** Other PTY ids the source tab still named: dropped from the session, never killed. */
  staleDroppedPtyIds: string[]
}

type SourceHolder = TerminalSessionPartition & {
  sourceTab: TerminalTab
  sourceLayout: TerminalLayoutSnapshot
}

function isOnlyLeaf(layout: TerminalLayoutSnapshot, leafId: string): boolean {
  return layout.root?.type === 'leaf' && layout.root.leafId === leafId
}

function sourceRefusal(holders: SourceHolder[], leafId: string): TerminalLeafIntoTabRefusal | null {
  if (holders.some(({ sourceLayout }) => !isOnlyLeaf(sourceLayout, leafId))) {
    return 'source_not_single_leaf'
  }
  if (
    holders.some(
      ({ sourceTab, sourceLayout }) =>
        sourceLayout.chatLeafId === leafId || sourceTab.viewMode === 'chat'
    )
  ) {
    return 'source_is_chat'
  }
  const pending = ({ sourceTab }: SourceHolder): boolean =>
    sourceTab.agentLaunchPane?.leafId === leafId && !sourceTab.agentLaunchPane.outcome
  return holders.some(pending) ? 'source_launch_pending' : null
}

function targetRefusal(
  owners: readonly TerminalSessionPartition[],
  holders: SourceHolder[],
  request: TerminalLeafIntoTabRequest
): TerminalLeafIntoTabRefusal | null {
  const { worktreeId, sourceTabId, targetTabId, targetLeafId } = request
  const rowOf = (session: WorkspaceSessionState): TerminalTab | undefined =>
    session.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === targetTabId)
  const holdsTargetLeaf = (session: WorkspaceSessionState): boolean =>
    rowOf(session) !== undefined &&
    layoutContainsLeafId(session.terminalLayoutsByTabId?.[targetTabId]?.root ?? null, targetLeafId)
  if (!owners.some(({ session }) => rowOf(session))) {
    return 'target_tab_missing'
  }
  if (!owners.some(({ session }) => holdsTargetLeaf(session))) {
    return 'target_leaf_missing'
  }
  if (owners.some(({ session }) => rowOf(session)?.viewMode === 'chat')) {
    return 'target_is_chat'
  }
  // A holder without the target leaf would keep a copy; a non-holder that lists either tab would
  // keep a target lacking the pane, or a ghost source row.
  const listsEitherTab = (session: WorkspaceSessionState): boolean =>
    [sourceTabId, targetTabId].some((tabId) =>
      session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId)
    )
  const mismatched = owners.some(({ session }) =>
    holders.some((holder) => holder.session === session)
      ? !holdsTargetLeaf(session)
      : listsEitherTab(session)
  )
  return mismatched ? 'partition_mismatch' : null
}

function joinInPartition(
  { session, sourceTab, sourceLayout }: SourceHolder,
  request: TerminalLeafIntoTabRequest,
  ptyId: string
): { session: WorkspaceSessionState; stale: string[] } | TerminalLeafIntoTabRefusal {
  const { worktreeId, sourceTabId, targetTabId, targetLeafId, leafId, placement } = request
  const targetLayout = session.terminalLayoutsByTabId[targetTabId]
  const grafted =
    targetLayout &&
    graftLeafBeside({
      target: targetLayout,
      source: sourceLayout,
      leafId,
      targetLeafId,
      side: placement.side,
      ptyId,
      fallbackTitle: sourceTab.customTitle
    })
  if (!grafted) {
    return 'target_leaf_missing'
  }
  const { from, to } = terminalLeafMovePaneKeys(request)
  const boundHere = sourceLayout.ptyIdsByLeafId?.[leafId]
  const localOnly = session.localOnlyScrollbackByTabId
  const scrollback = localOnly?.[sourceTabId]?.[leafId]
  // Re-keyed from the originals before the source closes: the close deletes by `S:` prefix and tabId.
  const joined: WorkspaceSessionState = {
    ...session,
    terminalLayoutsByTabId: { ...session.terminalLayoutsByTabId, [targetTabId]: grafted },
    ...(scrollback !== undefined
      ? {
          localOnlyScrollbackByTabId: {
            ...localOnly,
            [targetTabId]: { ...localOnly?.[targetTabId], [leafId]: scrollback }
          }
        }
      : {}),
    // A stale copy's incarnation belongs to the PTY it no longer names.
    terminalPtyIncarnationsByPaneKey: moveRecordKey(
      session.terminalPtyIncarnationsByPaneKey,
      from,
      boundHere && boundHere !== ptyId ? null : to
    ),
    sleepingAgentSessionsByPaneKey: moveRecordKey(
      session.sleepingAgentSessionsByPaneKey,
      from,
      to,
      (record) => ({ ...record, paneKey: to, tabId: targetTabId })
    )
  }
  const closed = closeTerminalSurfaceInWorkspaceSession(
    joined,
    worktreeId,
    { kind: 'tab', tabId: sourceTabId },
    { force: true, reason: 'cleanup' }
  )
  if (!closed.closed) {
    return 'invalid_request'
  }
  if (closed.ptyIdsToKill.includes(ptyId)) {
    return 'kill_list_contains_moved_pty'
  }
  return { session: closed.session, stale: closed.ptyIdsToKill }
}

/**
 * Joins a single-leaf tab's leaf into an existing tab beside one of its leaves and closes the
 * source tab, in one session write per owner partition. The leaf id and the PTY are kept; the
 * target owns the PTY before the source closes, so the close never lists it for a kill. The
 * renderer applies the move only after main reports it committed.
 */
export function planTerminalLeafMoveIntoTab(
  partitions: readonly TerminalSessionPartition[],
  request: TerminalLeafIntoTabRequest
): PlannedLeafMoveIntoTab {
  const { worktreeId, sourceTabId, leafId } = request
  const stopped = (result: TerminalLeafIntoTabResult): PlannedLeafMoveIntoTab => ({
    result,
    sessions: [],
    staleDroppedPtyIds: []
  })
  const refuse = (reason: TerminalLeafIntoTabRefusal): PlannedLeafMoveIntoTab =>
    stopped({ status: 'refused', reason })
  const owners = partitions.filter(({ hostId }) => isTerminalOwnerPartition(hostId))
  if (owners.some(({ session }) => leafHeldByOtherTab(session, sourceTabId, leafId))) {
    return refuse('leaf_in_other_tab')
  }
  const holders = owners.flatMap(({ hostId, session }): SourceHolder[] => {
    const sourceTab = session.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === sourceTabId)
    const sourceLayout = session.terminalLayoutsByTabId?.[sourceTabId]
    return sourceTab && sourceLayout && layoutContainsLeafId(sourceLayout.root, leafId)
      ? [{ hostId, session, sourceTab, sourceLayout }]
      : []
  })
  // Main never saw this leaf, so the renderer must not apply a move main did not commit.
  if (holders.length === 0) {
    return stopped({ status: 'not_held' })
  }
  const refusal = sourceRefusal(holders, leafId) ?? targetRefusal(owners, holders, request)
  if (refusal) {
    return refuse(refusal)
  }
  const boundPtyIds = new Set(
    holders.flatMap(({ sourceLayout }) => sourceLayout.ptyIdsByLeafId?.[leafId] ?? [])
  )
  // The renderer's live PTY id wins: after an SSH respawn one copy can still name the old PTY.
  const ptyId = request.ptyId ?? (boundPtyIds.size === 1 ? [...boundPtyIds][0] : null)
  if (boundPtyIds.size > 0 && !(ptyId && boundPtyIds.has(ptyId))) {
    return refuse('pty_mismatch')
  }
  if (!ptyId) {
    return refuse('pty_missing')
  }
  const sessions: TerminalSessionPartition[] = []
  const stale = new Set<string>()
  for (const holder of holders) {
    const joined = joinInPartition(holder, request, ptyId)
    if (typeof joined === 'string') {
      return refuse(joined)
    }
    sessions.push({ hostId: holder.hostId, session: joined.session })
    joined.stale.forEach((id) => stale.add(id))
  }
  return {
    result: { status: 'moved', ptyId, sourceTabClosed: true },
    sessions,
    staleDroppedPtyIds: [...stale]
  }
}
