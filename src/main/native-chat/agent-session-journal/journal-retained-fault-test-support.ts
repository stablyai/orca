import type { JournalHostDatabase } from './journal-host-database'
import { mutateTestJournalFixture } from './journal-drained-fixture-test-support'

export async function corruptTestRecordFence(
  database: JournalHostDatabase,
  sessionId: string
): Promise<void> {
  await mutateTestJournalFixture(database, (db) => {
    db.prepare(
      "UPDATE agent_session_records SET record_json = json_set(record_json, '$.lease.minimumNextFence', 'bad') WHERE session_id = ?"
    ).run(sessionId)
  })
}

export async function seedTestUnreadableReceipt(
  database: JournalHostDatabase,
  operationId: string,
  sessionId: string,
  callerKey: string,
  method: string
): Promise<void> {
  await mutateTestJournalFixture(database, (db) => {
    db.prepare(`INSERT INTO agent_session_command_receipts (operation_id, session_id, caller_key, method,
      fingerprint, status, result_json, rejection_json, accepted_at)
      VALUES (?, ?, ?, ?, 'x', 'accepted', '{', NULL, 0)`).run(
      operationId,
      sessionId,
      callerKey,
      method
    )
  })
}

export async function deleteTestCommandReceipt(
  database: JournalHostDatabase,
  operationId: string
): Promise<void> {
  await mutateTestJournalFixture(database, (db) => {
    db.prepare('DELETE FROM agent_session_command_receipts WHERE operation_id = ?').run(operationId)
  })
}

export async function deleteTestOperationLedger(database: JournalHostDatabase): Promise<void> {
  await mutateTestJournalFixture(database, (db) => {
    db.prepare('DELETE FROM agent_session_operations').run()
  })
}

export async function setTestRecoveredOutcomeFailure(
  database: JournalHostDatabase,
  enabled = true
): Promise<void> {
  await mutateTestJournalFixture(database, (db) => {
    db.exec('DROP TRIGGER IF EXISTS reject_recovered')
    if (enabled) {
      db.exec(`CREATE TRIGGER reject_recovered BEFORE INSERT ON journal_outcomes
      WHEN (NEW.field = 'items' AND json_extract(NEW.value_json, '$.recovered') = 1)
        OR (NEW.field = 'submissions' AND json_extract(NEW.value_json, '$[1].recovered') = 1)
      BEGIN SELECT RAISE(ABORT, 'temporary storage failure'); END`)
    }
  })
}
