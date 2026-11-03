import type { JournalRow } from './journal-row-schema'
import type Database from '../../sqlite/sync-database'
import { JournalPersistencePlan } from './journal-persistence-plan'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import type { AgentSessionStoreRowWrites } from '../../runtime/agent-session/records/agent-session-store-draft'
import { writeAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import type { CommandReceipt } from './command-receipt-schema'

type AcceptedReceipt = Extract<CommandReceipt, { status: 'accepted' }>

export function commandReceiptFixture(overrides: Partial<AcceptedReceipt> = {}): AcceptedReceipt {
  return {
    operationId: 'operation-1',
    sessionId: 'session-1',
    callerKey: 'caller-1',
    method: 'agentSession.send',
    fingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session-1',
      fields: { body: { text: 'hello' } }
    }),
    acceptedAt: 1000,
    status: 'accepted',
    result: { kind: 'journal-row', epoch: 'epoch-1', sequence: 1 },
    ...overrides
  }
}

export function writeCommandReceiptTestRecord(
  db: Database.Database | JournalPersistencePlan,
  sessionId = 'session-1',
  recordJson: string | null = '{}'
): void {
  const writes: AgentSessionStoreRowWrites = {
    records: {
      upsert: recordJson === null ? [] : [[sessionId, recordJson]],
      remove: recordJson === null ? [sessionId] : []
    },
    operations: { upsert: [], remove: [] },
    retiredClaimKeys: null,
    sessionTabs: null
  }
  if (db instanceof JournalPersistencePlan) {
    db.add({ kind: 'store', writes, insertOperationsIfAbsent: false })
  } else {
    writeAgentSessionStoreRows(db, writes)
  }
}

export function stageTestJournalRowReceipt(
  plan: JournalPersistencePlan,
  sessionId: string,
  row?: JournalRow
): void {
  if (!row) {
    throw new Error('missing receipt target')
  }
  plan.add({
    kind: 'receipt',
    scope: { kind: 'global' },
    receipt: commandReceiptFixture({
      operationId: `receipt-${row.seq}`,
      sessionId,
      result: { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
    })
  })
}
