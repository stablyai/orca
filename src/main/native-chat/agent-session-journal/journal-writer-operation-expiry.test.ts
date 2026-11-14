import { afterEach, expect, it } from 'vitest'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { pruneJournalWriterOperations } from './journal-writer-operation-expiry'
import {
  pendingAgentSessionOperationRow,
  agentSessionOperationKey
} from '../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { runJournalTransaction } from './database/journal-database'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

it('expires readable operations past a page of unknown schemas while preserving the unknown rows', () => {
  const { db } = domainLifecycleFixture(cleanups)
  const insert = db.prepare(
    'INSERT INTO agent_session_operations(operation_key,row_json) VALUES(?,?)'
  )
  const expired = pendingAgentSessionOperationRow({
    callerKey: 'caller',
    operationId: '1700000000000-00000000000000000000000000000001',
    fingerprint: 'saved',
    now: 1700000000000
  })
  const key = agentSessionOperationKey(expired.callerKey, expired.operationId)
  runJournalTransaction(db, () => {
    for (let i = 0; i < 129; i++) {
      insert.run(`unknown-${i}`, JSON.stringify({ expiresAt: 1, outcome: { status: 'future' } }))
    }
    insert.run(key, JSON.stringify(expired))
    pruneJournalWriterOperations(db, expired.expiresAt)
  })
  expect(
    db.prepare('SELECT row_json FROM agent_session_operations WHERE operation_key=?').get(key)
  ).toBeUndefined()
  expect(
    db
      .prepare("SELECT row_json FROM agent_session_operations WHERE operation_key='unknown-128'")
      .get()
  ).toEqual({
    row_json: '{"expiresAt":1,"outcome":{"status":"future"}}'
  })
})
