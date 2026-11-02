import { deriveContextTransferState } from './context-transfer-state'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { captureRecoveryContext } from './context-transfer-capture'
import {
  closeContextTransfers,
  contextTransferOwner,
  readContextTransfers,
  writeContextTransfer
} from './context-transfer-repository'
import { restoreJournal } from './journal-open'
import { renderJournalState } from './journal-reducer'
import { journalOutcomeSource } from './journal-outcome-format'

/** The explicit context edit and successor source commit in the command's existing transaction. */
export function rebaseContextTransfers(
  db: Database.Database,
  snapshot: AgentJournalSnapshot,
  commandId: string,
  at: number
): void {
  const records = readContextTransfers(db, snapshot.sessionId)
  if (records.some((row) => row.kind === 'closure' && row.commandId === commandId)) {
    return
  }
  const owner = contextTransferOwner(db, snapshot.sessionId)
  const state = deriveContextTransferState(records, owner?.providerHandleChain ?? [])
  if (state.kind === 'none') {
    return
  }
  const current = state.target
  const source = owner && agentSessionProviderHandleChainHead(owner.providerHandleChain)
  if (!source || !owner) {
    throw new Error('Context edit lost its native owner')
  }
  const capture = captureRecoveryContext(snapshot, (id) => id)
  const successorId =
    state.kind !== 'settled' && capture.capture.coverage.eligibleCount ? randomUUID() : undefined
  closeContextTransfers(db, snapshot.sessionId, commandId, 'rewind', at, successorId)
  if (!successorId) {
    return
  }
  // The old source remains in its closed handoff; the successor contains only kept rows.
  writeContextTransfer(db, {
    kind: 'handoff',
    id: successorId,
    handoffId: successorId,
    sessionId: snapshot.sessionId,
    sourceLink: source,
    sourceCursor: snapshot.cursor,
    contextFloor: capture.contextFloor,
    trigger: 'context-edit',
    capturedAt: at,
    capture: capture.capture,
    supersedesHandoffId: current.handoffId
  })
  writeContextTransfer(db, {
    kind: 'target',
    id: randomUUID(),
    handoffId: successorId,
    sessionId: snapshot.sessionId,
    preparedAt: at,
    fence: owner.lease.runtimeFence,
    acquisitionGeneration: null,
    sourceLinkId: source.linkId,
    predecessorTargetId: null,
    targetLink: null,
    firstInputId: null
  })
}

export function rebaseCompletedContextRewind(
  db: Database.Database,
  sessionId: string,
  publishedEpoch?: string
): void {
  if (!readContextTransfers(db, sessionId).length) {
    return
  }
  const owner = contextTransferOwner(db, sessionId)
  const rewind = owner?.rewind
  if (
    rewind?.phase !== 'completed' ||
    !rewind.epoch ||
    (publishedEpoch !== undefined && rewind.epoch !== publishedEpoch)
  ) {
    return
  }
  // Epoch builders publish their outcomes after the store receipt, in this same transaction.
  if (!journalOutcomeSource(db, sessionId, rewind.epoch)) {
    return
  }
  const saved = restoreJournal(db, sessionId)
  if (!saved || saved.damage || saved.newer || saved.state.epoch !== rewind.epoch) {
    throw new Error('Kept rewind context could not be read')
  }
  rebaseContextTransfers(db, renderJournalState(saved.state), rewind.operationId, Date.now())
}
