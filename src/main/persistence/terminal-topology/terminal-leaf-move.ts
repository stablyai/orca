import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retireLeavesFromTerminalLayout } from '../../runtime/mobile-session-terminal-retirement'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import {
  advanceTerminalTopologyRevision,
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

type PlannedTerminalLeafMove = {
  result: TerminalLeafMoveResult
  /** Every partition the plan rewrote; empty when nothing changes. */
  sessions: TerminalSessionPartition[]
}

function moveRecordKey<T>(
  record: Record<string, T> | undefined,
  fromKey: string,
  toKey: string | null,
  remap: (value: T) => T = (value) => value
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, fromKey)) {
    return record
  }
  const next = { ...record }
  const value = next[fromKey]
  delete next[fromKey]
  if (toKey !== null && value !== undefined) {
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
  const { pendingActivationSpawn, ...row } = createMinimalPersistedTerminalTab({
    worktreeId,
    tabId: targetTabId,
    ptyId: ptyId ?? '',
    existingTabCount: tabs.length,
    ...(sourceTab.startupCwd ? { startupCwd: sourceTab.startupCwd } : {})
  })
  const targetTab = {
    ...row,
    ptyId,
    // A moved live pane reattaches; only an unbound one still spawns on activation.
    ...(ptyId ? {} : { pendingActivationSpawn }),
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
    // Its sibling was never bound here; the sibling's own binding mints the layout again.
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
      // A stale copy's incarnation belongs to the PTY it no longer names.
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

/**
 * Moves one leaf and its binding into a new tab in a single session write (STA-9259). The leaf
 * id and the PTY are kept; only the tab half of the pane key changes, so every pane-keyed record
 * follows it here instead of being rebuilt later by a renderer save that main's membership rebase
 * would discard. Every owner partition holding the pane moves together: a relay reattach writes an
 * SSH pane into `local` as well as `ssh:`, and a copy left behind refuses the moved pane's bind.
 */
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
  // A layout left behind by a removed tab row owns nothing.
  const leafElsewhere = owners.some(({ session }) => {
    const tabIds = liveTabIds(session)
    return Object.entries(session.terminalLayoutsByTabId ?? {}).some(
      ([tabId, layout]) =>
        tabId !== sourceTabId &&
        tabIds.has(tabId) &&
        layoutContainsLeafId(layout?.root ?? null, leafId)
    )
  })
  if (leafElsewhere) {
    return refuse('leaf_in_other_tab')
  }
  const holders = owners.flatMap(({ hostId, session }) => {
    const sourceTab = session.tabsByWorktree?.[worktreeId]?.find((tab) => tab.id === sourceTabId)
    const sourceLayout = session.terminalLayoutsByTabId?.[sourceTabId]
    return sourceTab && sourceLayout && layoutContainsLeafId(sourceLayout.root, leafId)
      ? [{ hostId, session, sourceTab, sourceLayout }]
      : []
  })
  // Main never saw this leaf, so no binding of it can be duplicated here.
  if (holders.length === 0) {
    return { result: { status: 'not_held' }, sessions: [] }
  }
  const boundPtyIds = new Set(
    holders.flatMap(({ sourceLayout }) => sourceLayout.ptyIdsByLeafId?.[leafId] ?? [])
  )
  // The renderer's live PTY id wins: after an SSH respawn one copy can still name the old PTY.
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

/** Pane-keyed UI marks and SSH lease leaf addresses that must follow a moved leaf. */
export function rekeyMovedLeafProfileRecords(
  state: Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>,
  move: TerminalLeafMoveRequest
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(move)
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
    (lease) => lease.tabId === move.sourceTabId && lease.leafId === move.leafId
  )
  return {
    ...(nextUi ? { ui: nextUi } : {}),
    ...(leasesChanged
      ? {
          sshRemotePtyLeases: leases.map((lease) =>
            lease.tabId === move.sourceTabId && lease.leafId === move.leafId
              ? { ...lease, tabId: move.targetTabId }
              : lease
          )
        }
      : {})
  }
}
