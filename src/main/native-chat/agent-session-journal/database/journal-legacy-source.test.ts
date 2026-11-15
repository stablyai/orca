import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  initializeJournalDomainDatabase,
  journalDomainDatabasePath,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath } from './journal-host-database'
import { insertJournalRow, publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { journalSqlRetryRows } from '../journal-sql-retry-rows.test-fixture'
import { JournalSqlReaderPool } from '../journal-sql-reader-pool'
import { JournalSqlConversions } from '../journal-sql-conversions'
import { journalSqlReaderPath } from '../journal-sql-worker-bundle.test-fixture'
import { applyJournalSqlMaintenance } from '../journal-sql-maintenance'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

/** A journal last opened writable by an older build, which never created the later tables. */
function olderJournal(shape: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-source-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db } = openJournalDatabase(journalDatabasePath(root))
  runJournalTransaction(db, () => {
    publishJournalSessionEpoch(db, { sessionId: 'session', workspaceId: 'workspace' }, 'epoch')
    journalSqlRetryRows(false).forEach((row) => insertJournalRow(db, 'session', row))
  })
  db.exec(shape)
  db.close()
  return root
}

const SCHEMA_3 = `DROP TABLE queued_messages; DROP TABLE agent_session_command_receipts;
  DROP TABLE journal_outcomes; DROP TABLE journal_outcome_epochs;
  DROP TABLE journal_outcome_generations; DROP TABLE agent_session_attachment_claims;
  DROP TABLE agent_session_attachment_sweeps; DROP TABLE pr_chat_actions;
  DROP TABLE pr_check_events; DROP TABLE pr_event_deliveries; DROP TABLE pr_pending_heads;
  DROP TABLE pr_pending_actions; DROP TABLE pr_check_contexts; DROP TABLE agent_session_records;
  DROP TABLE agent_session_operations; DROP TABLE agent_session_retired_claim_keys;
  DROP TABLE agent_session_tabs; DROP TABLE agent_session_store_meta; PRAGMA user_version=3`

/** Early version four: no outcome tables, and queued cards before their later columns. */
const EARLY_SCHEMA_4 = `DROP TABLE journal_outcomes; DROP TABLE journal_outcome_epochs;
  DROP TABLE journal_outcome_generations; DROP INDEX queued_messages_consumed_as;
  ${['options_json', 'queued_sequence', 'queued_epoch', 'carried_from', 'consumed_as']
    .map((column) => `ALTER TABLE queued_messages DROP COLUMN ${column};`)
    .join('')}
  INSERT INTO queued_messages VALUES('session','queued',1,
    '{"kind":"message","role":"user","blocks":[{"type":"text","text":"later"}]}',
    'fingerprint',100,'host','waiting',NULL,NULL,NULL,NULL,NULL)`

it.each([
  ['schema 3', SCHEMA_3],
  ['early schema 4', EARLY_SCHEMA_4]
])('opens a chat saved by a %s journal without changing the file', async (_, shape) => {
  const root = olderJournal(shape)
  const original = journalDatabasePath(root)
  const before = createHash('sha256').update(readFileSync(original)).digest('hex')
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  const pool = new JournalSqlReaderPool(filename, original, journalSqlReaderPath())
  cleanup.push(() => pool.close())
  const conversions = new JournalSqlConversions(
    {
      maintain: async (operation) =>
        runJournalTransaction(db, () => applyJournalSqlMaintenance(db, operation))
    },
    pool,
    async () => {}
  )
  cleanup.push(() => conversions.close())
  expect(await conversions.ensure('session')).toBe('epoch')
  expect(db.prepare('SELECT COUNT(*) AS items FROM journal_items').get()!.items).toBeGreaterThan(0)
  expect(
    db.prepare("SELECT 1 FROM journal_queue_cards WHERE message_id='queued'").get() !== undefined
  ).toBe(shape === EARLY_SCHEMA_4)
  expect(createHash('sha256').update(readFileSync(original)).digest('hex')).toBe(before)
})

it('still refuses a version-four journal that lost the record tables its version created', async () => {
  const root = olderJournal(
    'DROP TABLE agent_session_command_receipts; DROP TABLE agent_session_records'
  )
  await expect(initializeJournalDomainDatabase(root)).rejects.toThrow(
    'no such table: agent_session_records'
  )
  expect(existsSync(journalDomainDatabasePath(root))).toBe(false)
})
