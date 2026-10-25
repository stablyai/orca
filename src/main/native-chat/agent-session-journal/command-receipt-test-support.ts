import type Database from '../../sqlite/sync-database'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { writeAgentSessionStoreRows } from '../../runtime/agent-session-record-rows'
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
  db: Database.Database,
  sessionId = 'session-1',
  recordJson: string | null = '{}'
): void {
  writeAgentSessionStoreRows(db, {
    records: {
      upsert: recordJson === null ? [] : [[sessionId, recordJson]],
      remove: recordJson === null ? [sessionId] : []
    },
    operations: { upsert: [], remove: [] },
    retiredClaimKeys: null,
    sessionTabs: null
  })
}
