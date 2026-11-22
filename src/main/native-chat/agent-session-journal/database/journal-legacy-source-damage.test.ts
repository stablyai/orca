import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { captureJournalLegacySourceReceipt } from './journal-legacy-source-capture'
import { openReconcilableJournalLegacySource } from './journal-legacy-source-damage'
import { JOURNAL_LEGACY_DAMAGE_CHECK } from './journal-legacy-source'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

/** An original shaped by `shape`, and this build's store, opened as a reconcile pass opens them. */
function reconcileOpen(shape: string, stored: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-damage-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'original.db')
  const { db: original } = openJournalDatabase(sourcePath)
  original.exec(shape)
  original.pragma('journal_mode = DELETE')
  original.close()
  const { db } = openJournalDatabase(join(root, 'store.db'))
  cleanup.push(() => db.close())
  const captured = captureJournalLegacySourceReceipt(sourcePath)
  if (stored !== undefined) {
    db.prepare('INSERT INTO agent_session_store_meta VALUES(?,?)').run(
      'journal.legacy-source-damaged.v1',
      stored.replace('"RECEIPT"', JSON.stringify(captured))
    )
  }
  const source: Database.Database | undefined = openReconcilableJournalLegacySource(
    db,
    sourcePath,
    captured
  )
  source?.close()
  const damaged = db
    .prepare(
      "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-source-damaged.v1'"
    )
    .get()
  return { read: source !== undefined, damaged: damaged && String(damaged.value) }
}

it("never calls a newer Orca's original damaged for lacking a table this build expects", () => {
  const opened = reconcileOpen(
    'ALTER TABLE journal_sessions RENAME TO journal_epochs; PRAGMA user_version=5',
    undefined
  )
  expect(opened).toEqual({ read: true, damaged: undefined })
})

it('reads again an unchanged original that a different damage check skipped', () => {
  const reads = (check: string) =>
    reconcileOpen(
      '',
      JSON.stringify({ receipt: 'RECEIPT', check, error: 'missing agent_session_tabs' })
    ).read
  expect(reads(JOURNAL_LEGACY_DAMAGE_CHECK)).toBe(false)
  expect(reads('an earlier check')).toBe(true)
})
