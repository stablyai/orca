import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreRowWrites } from '../../runtime/agent-session/records/agent-session-store-draft'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { writeAgentSessionStoreRows } from '../../runtime/agent-session/records/agent-session-record-rows'
import { JournalPersistencePlan } from './journal-persistence-plan'
import type { CommandReceipt, CommandReceiptScope } from './command-receipt-schema'
import { insertCommandReceiptIfAbsent } from './command-receipt-table'

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

export function writeTestCommandReceipt(
  db: Database.Database | JournalPersistencePlan,
  scope: CommandReceiptScope,
  receipt: CommandReceipt
): void {
  if (db instanceof JournalPersistencePlan) {
    db.add({ kind: 'receipt', scope, receipt })
  } else {
    insertCommandReceiptIfAbsent(db, scope, receipt)
  }
}
