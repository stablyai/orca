import { expect, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'

export function captureJournalMetadataPlans(db: Database.Database, prefix: string): () => string[] {
  const statements = vi.spyOn(db, 'prepare')
  return () => {
    const headers = [
      ...new Set(
        statements.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => sql.startsWith(prefix) && sql.includes('FROM journal_items '))
      )
    ]
    statements.mockRestore()
    expect(headers.length).toBeGreaterThan(0)
    for (const sql of headers) {
      assertJournalMetadataPlan(db, sql)
    }
    return headers
  }
}

/** Ordered metadata selection must not fetch a scalar stored beyond the large forms. */
export function assertJournalMetadataPlan(db: Database.Database, sql: string): void {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
  const details = plan.map((row) => String(row.detail)).join('\n')
  expect(details).toMatch(/SEARCH (?:item|journal_items) USING INDEX journal_items_/)
  expect(details).not.toContain('TEMP B-TREE')
  const root = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE name='journal_items'")
    .get()!.rootpage
  const columns = db.prepare('PRAGMA table_info(journal_items)').all()
  const firstBody = Number(columns.find((column) => column.name === 'payload_json')!.cid)
  const instructions = db.prepare(`EXPLAIN ${sql}`).all()
  const cursors = new Set(
    instructions.filter((row) => row.opcode === 'OpenRead' && row.p2 === root).map((row) => row.p1)
  )
  const reads = instructions.filter((row) => row.opcode === 'Column' && cursors.has(row.p1))
  expect(reads.length).toBeGreaterThan(0)
  for (const row of reads) {
    // SQLite's length-only Column flag avoids fetching the payload's content.
    if ((Number(row.p5) & 0x40) === 0) {
      expect(Number(row.p2)).toBeLessThan(firstBody)
    }
  }
}
