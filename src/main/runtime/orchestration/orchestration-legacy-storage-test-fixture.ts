import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

export type LegacyStorageCutoverFixture = {
  dbPath: string
  currentRunId: string
  unrelatedRunId: string
  currentDispatchId: string
  legacyTaskId: string
  legacyDispatchId: string
  legacyGateId: string
  legacyMessageIds: string[]
  legacyQuestionId: string
  legacyDeliveryId: string
  rejectionMessageId: string
  lookalikeMessageId: string
  malformedRejectionMessageIds: string[]
}

export function createLegacyStorageCutoverFixture(): {
  fixture: LegacyStorageCutoverFixture
  tempDir: string
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-legacy-storage-'))
  const dbPath = join(tempDir, 'orchestration.db')
  const first = new OrchestrationDb(dbPath)
  const currentRun = first.createRun({
    objective: 'Current work',
    coordinatorHandle: 'term_current_coord',
    coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111'
  })
  const currentTask = first.createTask({ spec: 'current', runId: currentRun.id })
  const unrelatedRun = first.createRun({
    objective: 'Unrelated current work',
    coordinatorHandle: 'term_unrelated_coord',
    coordinatorPaneKey: 'tab_unrelated:55555555-5555-4555-8555-555555555555'
  })
  const currentDispatch = createRootDispatch(
    first,
    currentTask.id,
    'term_current_worker',
    'tab_current:22222222-2222-4222-9222-222222222222',
    'current_launch_hash'
  )
  first.insertMessage({
    runId: currentRun.id,
    from: 'term_current_worker',
    to: `run:${currentRun.id}`,
    subject: 'current mail'
  })

  const legacyTask = first.createTask({
    spec: 'legacy',
    createdByTerminalHandle: 'term_legacy_coord'
  })
  createRootDispatch(
    first,
    legacyTask.id,
    'term_legacy_worker',
    'tab_legacy:33333333-3333-4333-8333-333333333333'
  )
  const legacyGate = first.createGate({
    taskId: legacyTask.id,
    question: 'Retained gate?'
  })
  first.resolveGate(legacyGate.id, 'continue')
  const retryDispatch = createRootDispatch(
    first,
    legacyTask.id,
    'term_legacy_worker',
    'tab_legacy:33333333-3333-4333-8333-333333333333'
  )
  const legacyMessages = [
    first.insertMessage({
      from: 'term_legacy_coord',
      to: 'term_legacy_worker',
      subject: 'read worker mail'
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'read coordinator mail'
    }),
    first.insertMessage({
      from: 'term_legacy_coord',
      to: 'term_legacy_worker',
      subject: 'second worker page'
    })
  ]
  first.markAsRead(legacyMessages.map((message) => message.id))
  const question = first.createQuestion({
    runId: LEGACY_RUN_ID,
    dispatchId: retryDispatch.id,
    askerHandle: 'term_legacy_worker',
    question: 'Retained question?'
  })
  const rejection = first.insertMessage({
    from: 'term_legacy_worker',
    to: 'term_legacy_coord',
    subject: 'Rejected heartbeat',
    type: 'heartbeat',
    payload: JSON.stringify({ _orcaLifecycleRejection: { code: 'migration', reason: 'cutover' } })
  })
  const lookalike = first.insertMessage({
    from: 'term_legacy_worker',
    to: 'term_legacy_coord',
    subject: 'Ordinary legacy mail',
    payload: JSON.stringify({
      userData: { _orcaLifecycleRejection: { code: 'not-a-top-level-audit-marker' } }
    })
  })
  const malformedRejections = [
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Invalid JSON marker',
      payload: '{"_orcaLifecycleRejection":'
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Array marker',
      payload: JSON.stringify({ _orcaLifecycleRejection: [] })
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'String marker',
      payload: JSON.stringify({ _orcaLifecycleRejection: 'migration' })
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Incomplete marker',
      payload: JSON.stringify({ _orcaLifecycleRejection: { code: 'migration' } })
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Non-string marker fields',
      payload: JSON.stringify({ _orcaLifecycleRejection: { code: 19, reason: false } })
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Array root',
      payload: JSON.stringify([
        { _orcaLifecycleRejection: { code: 'migration', reason: 'nested' } }
      ])
    }),
    first.insertMessage({
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'String root',
      payload: JSON.stringify('_orcaLifecycleRejection')
    })
  ]
  first.close()

  const raw = new Database(dbPath)
  const legacyDeliveryId = 'delivery_legacy_outstanding'
  raw
    .prepare(
      `INSERT INTO deliveries (
         id, run_id, consumer_generation, message_ids, status
       ) VALUES (?, ?, 0, ?, 'outstanding')`
    )
    .run(legacyDeliveryId, LEGACY_RUN_ID, JSON.stringify([legacyMessages[0].id]))
  raw
    .prepare("UPDATE messages SET delivery_contract = 'legacy_direct' WHERE id = ?")
    .run(rejection.id)
  const seedAuditOnly = raw.prepare(
    "UPDATE messages SET delivery_contract = 'audit_only' WHERE id = ?"
  )
  for (const message of [lookalike, ...malformedRejections]) {
    seedAuditOnly.run(message.id)
  }
  raw.exec(`
    DROP INDEX IF EXISTS idx_messages_delivery_contract;
    DROP TABLE legacy_mail_receipts;
    DROP TABLE legacy_operation_receipts;
    DROP TABLE legacy_compatibility_principals;
    DROP TABLE legacy_adoptions;
  `)
  raw.pragma('user_version = 18')
  raw.close()

  return {
    tempDir,
    fixture: {
      dbPath,
      currentRunId: currentRun.id,
      unrelatedRunId: unrelatedRun.id,
      currentDispatchId: currentDispatch.id,
      legacyTaskId: legacyTask.id,
      legacyDispatchId: retryDispatch.id,
      legacyGateId: legacyGate.id,
      legacyMessageIds: legacyMessages.map((message) => message.id),
      legacyQuestionId: question.message.id,
      legacyDeliveryId,
      rejectionMessageId: rejection.id,
      lookalikeMessageId: lookalike.id,
      malformedRejectionMessageIds: malformedRejections.map((message) => message.id)
    }
  }
}
