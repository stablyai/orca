import { rekeyPaneProfileRecords } from './pane-profile-record-rekey'
export { moveRecordKey, rekeyPaneProfileRecords } from './pane-profile-record-rekey'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { SessionUnitIndex } from '../../../shared/session-unit-index'

import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'

import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
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
  isTerminalOwnerPartition,
  type TerminalSessionPartition
} from './terminal-topology-membership'

type PlannedTerminalLeafMove = {
  result: TerminalLeafMoveResult
  sessions: TerminalSessionPartition[]
}

function hasTabId(reader: SessionUnitReader, tabId: string): boolean {
  return (
    reader.terminalOccurrenceCount(tabId) > 0 ||
    reader.unit('terminalLayoutsByTabId', tabId).present
  )
}

/** Removed-tab layouts cannot claim leaf ownership. */
export function leafHeldByOtherTab(
  source: WorkspaceSessionState | SessionUnitReader,
  sourceTabId: string,
  leafId: string
): boolean {
  const reader =
    source instanceof SessionUnitReader
      ? source
      : new SessionUnitReader(source, new SessionUnitIndex(source))
  return reader
    .references('leaf', leafId)
    .some(
      ({ field, key }) =>
        field === 'terminalLayoutsByTabId' &&
        key !== sourceTabId &&
        reader.terminalOccurrenceCount(key) > 0
    )
}

type SourceHolder = TerminalSessionPartition & {
  sourceTab: TerminalTab
  sourceLayout: TerminalLayoutSnapshot
  reader: SessionUnitReader
}

function moveLeafInPartition(
  { reader, sourceTab, sourceLayout }: SourceHolder,
  request: TerminalLeafMoveRequest,
  ptyId: string | null
): SessionUnitReader {
  const { worktreeId, sourceTabId, targetTabId, leafId } = request
  const tabs = reader.unit('tabsByWorktree', worktreeId).value ?? []
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
  reader.write('terminalLayoutsByTabId', targetTabId, {
    present: true,
    value: {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {}),
      ...(movedTitle ? { titlesByLeafId: { [leafId]: movedTitle } } : {}),
      ...(sourceLayout.chatLeafId === leafId ? { chatLeafId: leafId } : {})
    }
  })
  reader.write(
    'terminalLayoutsByTabId',
    sourceTabId,
    remainingLayout
      ? { present: true, value: remainingLayout }
      : { present: false, value: undefined }
  )
  if (ptyId && reader.unit('remoteSessionIdsByTabId', sourceTabId).value === ptyId) {
    reader.write('remoteSessionIdsByTabId', targetTabId, { present: true, value: ptyId })
    reader.write(
      'remoteSessionIdsByTabId',
      sourceTabId,
      remainingPtyIds[0]
        ? { present: true, value: remainingPtyIds[0] }
        : { present: false, value: undefined }
    )
  }
  reader.write('tabsByWorktree', worktreeId, { present: true, value: [...nextTabs, targetTab] })
  const incarnation = reader.unit('terminalPtyIncarnationsByPaneKey', fromPaneKey)
  if (incarnation.present) {
    reader.write('terminalPtyIncarnationsByPaneKey', fromPaneKey, {
      present: false,
      value: undefined
    })
    if (!(boundHere && boundHere !== ptyId)) {
      reader.write('terminalPtyIncarnationsByPaneKey', toPaneKey, incarnation)
    }
  }
  const sleep = reader.unit('sleepingAgentSessionsByPaneKey', fromPaneKey)
  if (sleep.present) {
    reader.write('sleepingAgentSessionsByPaneKey', fromPaneKey, {
      present: false,
      value: undefined
    })
    reader.write('sleepingAgentSessionsByPaneKey', toPaneKey, {
      present: true,
      value: { ...sleep.value, paneKey: toPaneKey, tabId: targetTabId }
    })
  }
  for (const field of [
    'terminalPtyIncarnationsByPaneKey',
    'sleepingAgentSessionsByPaneKey'
  ] as const) {
    reader.reconcileField(field, {
      kind: 'replacement',
      present: true,
      ...(reader.prior[field] === undefined
        ? { valueWhenEmpty: 'undefined' as const }
        : { explicitEmpty: true })
    })
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  reader.write('terminalTopologyRevisionByRepoId', repoId, {
    present: true,
    value: (reader.unit('terminalTopologyRevisionByRepoId', repoId).value ?? 0) + 1
  })
  return reader
}

/** Move every partition holder and pane-keyed record atomically; preserve leaf/PTY identity (STA-9259). */
export function planTerminalLeafMove(
  partitions: readonly TerminalSessionPartition[],
  request: TerminalLeafMoveRequest
): PlannedTerminalLeafMove {
  const { worktreeId, sourceTabId, leafId } = request
  const inputs = partitions.map((partition) => ({
    ...partition,
    reader:
      partition.prepared ??
      new SessionUnitReader(partition.session, new SessionUnitIndex(partition.session))
  }))
  const refuse = (
    reason: Extract<TerminalLeafMoveResult, { status: 'refused' }>['reason']
  ): PlannedTerminalLeafMove => ({ result: { status: 'refused', reason }, sessions: [] })
  const owners = inputs.filter(({ hostId }) => isTerminalOwnerPartition(hostId))
  if (inputs.some(({ reader }) => hasTabId(reader, request.targetTabId))) {
    return refuse('target_tab_exists')
  }
  if (owners.some(({ reader }) => leafHeldByOtherTab(reader, sourceTabId, leafId))) {
    return refuse('leaf_in_other_tab')
  }
  const holders = owners.flatMap(({ hostId, session, reader, prepared }) => {
    const sourceTab = reader
      .unit('tabsByWorktree', worktreeId)
      .value?.find((tab) => tab.id === sourceTabId)
    const sourceLayout = reader.unit('terminalLayoutsByTabId', sourceTabId).value
    return sourceTab && sourceLayout && layoutContainsLeafId(sourceLayout.root, leafId)
      ? [{ hostId, session, reader, prepared, sourceTab, sourceLayout }]
      : []
  })
  if (holders.length === 0) {
    return { result: { status: 'not_held' }, sessions: [] }
  }
  if (
    request.keepsSourcePane &&
    holders.some(({ sourceLayout }) => collectLeafIds(sourceLayout.root).length < 2)
  ) {
    return refuse('last_pane')
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
    sessions: holders.map((holder) => {
      const prepared = moveLeafInPartition(holder, request, ptyId)
      return {
        hostId: holder.hostId,
        session: prepared.snapshot(),
        ...(holder.prepared ? { prepared } : {})
      }
    })
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
