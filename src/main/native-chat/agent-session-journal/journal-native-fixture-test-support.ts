import type { JournalHostDatabase } from './journal-host-database'
import { mutateTestJournalFixture as mutateFixture } from './journal-drained-fixture-test-support'
import type { QueuedMessageRow } from './queued-message-table'
export * from './journal-row-fixture-test-support'

export async function seedTestLegacyQueueRows(
  database: JournalHostDatabase,
  sessionId: string,
  rows: readonly (Omit<QueuedMessageRow, 'state'> & { state: string; rawBodyJson?: string })[]
): Promise<void> {
  await mutateFixture(database, (db) => {
    const insert = db.prepare(`INSERT INTO queued_messages
      (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, hold_reason, returned_reason, returned_rejection, consumed_as, queued_epoch, queued_sequence, options_json)
      VALUES (?, ?, ?, ?, ?, 0, 'legacy-fixture', ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of rows) {
      insert.run(
        sessionId,
        row.messageId,
        row.position,
        row.rawBodyJson ?? JSON.stringify(row.body),
        row.fingerprint,
        row.state,
        row.holdReason,
        row.returnedReason,
        row.returnedRejection ? JSON.stringify(row.returnedRejection) : null,
        row.consumedAs,
        row.queuedAt?.epoch ?? null,
        row.queuedAt?.sequence ?? null,
        row.options ? JSON.stringify(row.options) : null
      )
    }
  })
}

export type TestJournalTriggerName =
  | 'failure'
  | 'no_upgrade'
  | 'b2_fail_import'
  | 'b2_raw_fail_import'
  | 'b2_source_fail_import'
  | 'fail_import'
  | 'overlay_import_failure'
  | 'overlay_direct_import_failure'
  | 'b2_perf_fail_import'
  | 'overlay_scale_import_failure'
  | 'fail_receipt'
  | 'fail_stop_receipt'

export async function setTestJournalTrigger(
  database: JournalHostDatabase,
  trigger:
    | {
        name: TestJournalTriggerName
        event: 'INSERT' | 'UPDATE' | 'DELETE'
        table:
          | 'journal_outcomes'
          | 'journal_outcome_epochs'
          | 'agent_session_command_receipts'
          | 'agent_session_operations'
          | 'queued_messages'
        rollback?: boolean
        message?:
          | 'failure'
          | 'upgrade failed'
          | 'disk full'
          | 'import failure'
          | 'receipt storage failed'
          | 'receipt unavailable'
      }
    | { remove: TestJournalTriggerName }
): Promise<void> {
  await mutateFixture(database, (db) => {
    if ('remove' in trigger) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.remove}`)
    } else {
      db.exec(
        `CREATE TRIGGER ${trigger.name} BEFORE ${trigger.event} ON ${trigger.table} BEGIN SELECT RAISE(${trigger.rollback ? 'ROLLBACK' : 'ABORT'}, '${trigger.message ?? 'failure'}'); END`
      )
    }
  })
}

export async function setTestJournalOutcomeFormat(
  database: JournalHostDatabase,
  format: number,
  ordinaryOnly = false,
  summary = true
): Promise<void> {
  await mutateFixture(database, (db) => {
    if (ordinaryOnly) {
      db.exec("DELETE FROM journal_outcomes WHERE field IN ('inputEntries','inputCards')")
      db.prepare('UPDATE journal_outcomes SET format = ?').run(format)
    }
    if (!summary) {
      db.prepare('UPDATE journal_outcomes SET format = ?').run(format)
    }
    if (summary) {
      db.prepare('UPDATE journal_outcome_epochs SET format = ?').run(format)
    }
  })
}

/** Saved pre-restart sweep/claim rows, including an unreadable conversation that must remain protected. */
export async function seedTestAttachmentCleanup(
  database: JournalHostDatabase,
  scenario: string
): Promise<void> {
  await mutateFixture(database, (db) => {
    if (scenario === 'resumed') {
      db.prepare('INSERT INTO agent_session_attachment_sweeps VALUES (?, ?)').run(
        'expired-upload',
        1
      )
    }
    if (scenario === 'orphan' || scenario === 'partial-prune') {
      const insert = db.prepare('INSERT INTO agent_session_attachment_claims VALUES (?, ?, ?)')
      insert.run('expired-upload', 'gone-session', 1)
      if (scenario === 'partial-prune') {
        insert.run('other-upload', 'unreadable-session', 1)
      }
    }
  })
}

export async function moveTestLegacyQueueRow(
  database: JournalHostDatabase,
  messageId: string,
  position: number
): Promise<void> {
  await mutateFixture(database, (db) => {
    db.prepare('UPDATE queued_messages SET position = ? WHERE message_id = ?').run(
      position,
      messageId
    )
  })
}

export async function deleteTestJournalOutcome(
  database: JournalHostDatabase,
  field: string,
  key: string
): Promise<void> {
  await mutateFixture(database, (db) => {
    db.prepare('DELETE FROM journal_outcomes WHERE field = ? AND entry_key = ?').run(field, key)
  })
}

export async function markTestUnclaimedUpload(
  database: JournalHostDatabase,
  uploadId: string,
  now: number
): Promise<boolean> {
  let marked = false
  await database.transaction((plan) =>
    plan.add({ kind: 'sweep', operation: { kind: 'mark', uploadId, now } }, (result) => {
      marked = result === true
    })
  )
  return marked
}

export async function setTestUnsupportedJournalRows(
  database: JournalHostDatabase,
  sessionId: string,
  mode: 'newer' | 'missing'
): Promise<void> {
  await mutateFixture(database, (db) => {
    if (mode === 'newer') {
      db.prepare(
        "UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 6) WHERE session_id = ?"
      ).run(sessionId)
    } else {
      db.prepare('DELETE FROM journal_rows WHERE session_id = ?').run(sessionId)
    }
  })
}

export async function corruptTestCommandReceipt(
  database: JournalHostDatabase,
  operationId: string
): Promise<void> {
  await mutateFixture(database, (db) => {
    db.prepare(
      'UPDATE agent_session_command_receipts SET result_json = ? WHERE operation_id = ?'
    ).run('{', operationId)
  })
}

export async function setTestSettlementFailure(
  database: JournalHostDatabase,
  failure: { sessionId: string; kind: 'item' | 'lifecycle-batch'; afterSequence: number } | null
): Promise<void> {
  await mutateFixture(database, (db) => {
    if (!failure) {
      db.exec('DROP TRIGGER IF EXISTS reject_later_settlement')
      return
    }
    const sessionId = failure.sessionId.replaceAll("'", "''")
    db.exec(`CREATE TRIGGER reject_later_settlement BEFORE INSERT ON journal_rows
      WHEN NEW.session_id = '${sessionId}' AND json_extract(NEW.row_json, '$.recovered') = 1
      AND json_extract(NEW.row_json, '$.kind') = '${failure.kind}' AND NEW.seq > ${Number(failure.afterSequence)}
      BEGIN SELECT RAISE(ABORT, 'later settlement row rejected'); END`)
  })
}

export * from './journal-outcome-fixture-test-support'

export async function setTestLaterRowFailure(
  database: JournalHostDatabase,
  failure: { sessionId?: string; afterSequence: number } | null
): Promise<void> {
  await mutateFixture(database, (db) => {
    db.exec('DROP TRIGGER IF EXISTS reject_test_later_row')
    if (!failure) {
      return
    }
    const session =
      failure.sessionId === undefined
        ? ''
        : `NEW.session_id = '${failure.sessionId.replaceAll("'", "''")}' AND `
    db.exec(`CREATE TRIGGER reject_test_later_row BEFORE INSERT ON journal_rows
      WHEN ${session}NEW.seq > ${Number(failure.afterSequence)}
      BEGIN SELECT RAISE(ABORT, 'later journal row rejected'); END`)
  })
}
