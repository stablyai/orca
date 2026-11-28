// #51545: each sweep pass proves an older Orca's upload claims kept on the chat writer. Guards that
// proof: it takes one bounded page of claims per writer admission, so a large original adds
// admissions other chat writes interleave with, never one long one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import { openJournalDomainDatabase } from './journal-domain-database'
import { journalDatabasePath, journalDomainDatabasePath } from './journal-host-database'
import { journalLegacyCustodyFrom, journalLegacyCustodyPage } from './journal-legacy-custody'
import { captureJournalLegacySourceReceipt } from './journal-legacy-source-capture'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function claim(target: Database.Database, count: number, close: boolean): void {
  try {
    const insert = target.prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    runJournalTransaction(target, () => {
      for (let index = 0; index < count; index++) {
        insert.run(`upload-${index}`, 'chat', 1)
      }
    })
  } finally {
    if (close) {
      target.close()
    }
  }
}

it.each([
  [1280, 11],
  [12800, 101]
])('proves %i kept claims in %i bounded writer admissions', (count, admissions) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-custody-perf-'))
  roots.push(root)
  const path = journalDatabasePath(root)
  claim(openJournalDatabase(path).db, count, true)
  const { db } = openJournalDomainDatabase(journalDomainDatabasePath(root))
  try {
    claim(db, count, false)
    const start = journalLegacyCustodyFrom(path, captureJournalLegacySourceReceipt(path))
    let page: boolean | number = 0
    let admitted = 0
    while (typeof page === 'number') {
      admitted++
      page = journalLegacyCustodyPage(root, db, start, page)
    }
    expect(page).toBe(true)
    expect(admitted).toBe(admissions)
  } finally {
    db.close()
  }
})
