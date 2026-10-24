import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireLeavesFromTerminalLayout } from '../../../shared/terminal-layout-leaf-retirement'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import { writeRestorable } from './restorable-write'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'
import {
  advanceTerminalTopologyRevision,
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

type PlannedTerminalLeafMove = {
  result: TerminalLeafMoveResult
  sessions: TerminalSessionPartition[]
}

export function moveRecordKey<T>(
  record: Record<string, T> | undefined,
  fromKey: string,
  toKey: string | null,
  remap: (value: T) => T = (value) => value,
  /** Preserve existing destination values on collision. */
  keepTarget = false
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, fromKey)) {
    return record
  }
  const next = { ...record }
  const value = next[fromKey]
  delete next[fromKey]
  if (toKey !== null && value !== undefined && !(keepTarget && Object.hasOwn(next, toKey))) {
    next[toKey] = remap(value)
  }
  return next
}

function liveTabIds(session: WorkspaceSessionState): Set<string> {
  return new Set(
    Object.values(session.tabsByWorktree ?? {}).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
}

function hasTabId(session: WorkspaceSessionState, tabId: string): boolean {
  return (
    liveTabIds(session).has(tabId) || Object.hasOwn(session.terminalLayoutsByTabId ?? {}, tabId)
  )
}

/** Removed-tab layouts cannot claim leaf ownership. */
export function leafHeldByOtherTab(
  session: WorkspaceSessionState,
  sourceTabId: string,
  leafId: string
): boolean {
  const tabIds = liveTabIds(session)
  return Object.entries(session.terminalLayoutsByTabId ?? {}).some(
    ([tabId, layout]) =>
      tabId !== sourceTabId &&
      tabIds.has(tabId) &&
      layoutContainsLeafId(layout?.root ?? null, leafId)
  )
}

type SourceHolder = TerminalSessionPartition & {
  sourceTab: TerminalTab
  sourceLayout: TerminalLayoutSnapshot
}

function moveLeafInPartition(
  { session, sourceTab, sourceLayout }: SourceHolder,
  request: TerminalLeafMoveRequest,
  ptyId: string | null
): WorkspaceSessionState {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const tabs = session.tabsByWorktree?.[worktreeId] ?? []
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(request)
  const boundHere = sourceLayout.ptyIdsByLeafId?.[leafId]
  const remainingLayout = retireLeavesFromTerminalLayout(sourceLayout, new Set([leafId]))
  const remainingPtyIds = Object.values(remainingLayout?.ptyIdsByLeafId ?? {})
  const row = createMinimalPersistedTerminalTab({
    worktreeId,
    tabId: targetTabId,
    ptyId: ptyId ?? '',
    existingTabCount: tabs.length,
    ...(sourceTab.startupCwd ? { startupCwd: sourceTab.startupCwd } : {})
  })
  const targetTab = {
    ...row,
    ptyId,
    ...(sourceTab.shellOverride ? { shellOverride: sourceTab.shellOverride } : {})
  }
  const nextTabs = tabs.map((tab) =>
    tab.id === sourceTabId && tab.ptyId === ptyId
      ? { ...tab, ptyId: remainingPtyIds[0] ?? null }
      : tab
  )
  const movedTitle = sourceLayout.titlesByLeafId?.[leafId]
  const terminalLayoutsByTabId = {
    ...session.terminalLayoutsByTabId,
    [targetTabId]: {
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {}),
      ...(movedTitle ? { titlesByLeafId: { [leafId]: movedTitle } } : {}),
      ...(sourceLayout.chatLeafId === leafId ? { chatLeafId: leafId } : {})
    }
  }
  if (remainingLayout) {
    terminalLayoutsByTabId[sourceTabId] = remainingLayout
  } else {
    // A sibling never bound here can recreate its layout when its own binding arrives.
    delete terminalLayoutsByTabId[sourceTabId]
  }
  const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
  if (ptyId && remoteSessionIdsByTabId[sourceTabId] === ptyId) {
    remoteSessionIdsByTabId[targetTabId] = ptyId
    if (remainingPtyIds[0]) {
      remoteSessionIdsByTabId[sourceTabId] = remainingPtyIds[0]
    } else {
      delete remoteSessionIdsByTabId[sourceTabId]
    }
  }
  return advanceTerminalTopologyRevision(
    {
      ...session,
      tabsByWorktree: { ...session.tabsByWorktree, [worktreeId]: [...nextTabs, targetTab] },
      terminalLayoutsByTabId,
      ...(session.remoteSessionIdsByTabId ? { remoteSessionIdsByTabId } : {}),
      // Stale copies cannot carry another PTY's incarnation to the destination.
      terminalPtyIncarnationsByPaneKey: moveRecordKey(
        session.terminalPtyIncarnationsByPaneKey,
        fromPaneKey,
        boundHere && boundHere !== ptyId ? null : toPaneKey
      ),
      sleepingAgentSessionsByPaneKey: moveRecordKey(
        session.sleepingAgentSessionsByPaneKey,
        fromPaneKey,
        toPaneKey,
        (record) => ({ ...record, paneKey: toPaneKey, tabId: targetTabId })
      )
    },
    worktreeId
  )
}

/** Move every partition holder and pane-keyed record atomically; preserve leaf/PTY identity (STA-9259). */
export function planTerminalLeafMove(
  partitions: readonly TerminalSessionPartition[],
  request: TerminalLeafMoveRequest
): PlannedTerminalLeafMove {
  const { worktreeId, sourceTabId, leafId } = request
  const refuse = (
    reason: Extract<TerminalLeafMoveResult, { status: 'refused' }>['reason']
  ): PlannedTerminalLeafMove => ({ result: { status: 'refused', reason }, sessions: [] })
  const owners = partitions.filter(({ hostId }) => isTerminalOwnerPartition(hostId))
  if (partitions.some(({ session }) => hasTabId(session, request.targetTabId))) {
    return refuse('target_tab_exists')
  }
  if (owners.some(({ session }) => leafHeldByOtherTab(session, sourceTabId, leafId))) {
    return refuse('leaf_in_other_tab')
  }
  const holders = owners.flatMap(({ hostId, session }) => {
    const sourceTab = session.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === sourceTabId)
    const sourceLayout = session.terminalLayoutsByTabId?.[sourceTabId]
    return sourceTab && sourceLayout && layoutContainsLeafId(sourceLayout.root, leafId)
      ? [{ hostId, session, sourceTab, sourceLayout }]
      : []
  })
  if (holders.length === 0) {
    return { result: { status: 'not_held' }, sessions: [] }
  }
  const boundPtyIds = new Set(
    holders.flatMap(({ sourceLayout }) => sourceLayout.ptyIdsByLeafId?.[leafId] ?? [])
  )
  // Prefer the renderer's live PTY; an SSH respawn can leave an old ID in one copy.
  const ptyId = request.ptyId ?? (boundPtyIds.size === 1 ? [...boundPtyIds][0] : null)
  if (boundPtyIds.size > 0 && !(ptyId && boundPtyIds.has(ptyId))) {
    return refuse('pty_mismatch')
  }
  return {
    result: { status: 'moved', ptyId },
    sessions: holders.map((holder) => ({
      hostId: holder.hostId,
      session: moveLeafInPartition(holder, request, ptyId)
    }))
  }
}

const PANE_KEYED_UI_RECORDS = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const

type PaneAddress = { tabId: string; leafId: string }

export function rekeyPaneProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  from: PaneAddress,
  to: PaneAddress
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const fromPaneKey = makePaneKey(from.tabId, from.leafId)
  const toPaneKey = makePaneKey(to.tabId, to.leafId)
  const ui = state.ui
  let nextUi: PersistedState['ui'] | undefined
  for (const key of PANE_KEYED_UI_RECORDS) {
    const moved = moveRecordKey(ui?.[key], fromPaneKey, toPaneKey)
    if (ui && moved !== ui[key]) {
      nextUi = { ...(nextUi ?? ui), [key]: moved }
    }
  }
  const leases = state.sshRemotePtyLeases ?? []
  const leasesChanged = leases.some(
    (lease) => lease.tabId === from.tabId && lease.leafId === from.leafId
  )
  return {
    ...(nextUi ? { ui: nextUi } : {}),
    ...(leasesChanged
      ? {
          sshRemotePtyLeases: leases.map((lease) =>
            lease.tabId === from.tabId && lease.leafId === from.leafId
              ? { ...lease, tabId: to.tabId, leafId: to.leafId }
              : lease
          )
        }
      : {})
  }
}

export function rekeyMovedLeafProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  move: TerminalLeafMoveRequest
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  return rekeyPaneProfileRecords(
    state,
    { tabId: move.sourceTabId, leafId: move.leafId },
    { tabId: move.targetTabId, leafId: move.leafId }
  )
}

/** Return restores for rekeyed UI marks and SSH leases. */
export function writeMovedLeafProfileRecords(
  request: TerminalLeafMoveRequest,
  context: TerminalTopologyCommitContext
): (() => void)[] {
  return writeRekeyedProfileRecords(rekeyMovedLeafProfileRecords(context.state, request), context)
}

/** Return restores for rekeyed profile records. */
export function writeRekeyedProfileRecords(
  rekeyed: ReturnType<typeof rekeyPaneProfileRecords>,
  context: TerminalTopologyCommitContext
): (() => void)[] {
  const { state } = context
  const restores: (() => void)[] = []
  if (rekeyed.ui) {
    restores.push(
      writeRestorable(
        () => state.ui,
        (ui) => (state.ui = ui),
        rekeyed.ui
      )
    )
    context.markDirty('ui')
  }
  if (rekeyed.sshRemotePtyLeases) {
    restores.push(
      writeRestorable(
        () => state.sshRemotePtyLeases,
        (leases) => (state.sshRemotePtyLeases = leases),
        rekeyed.sshRemotePtyLeases
      )
    )
    context.markDirty('sshRemotePtyLeases')
  }
  return restores
}
