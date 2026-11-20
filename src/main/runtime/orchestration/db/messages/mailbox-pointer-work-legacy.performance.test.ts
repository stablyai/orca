import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { pointerWorkExistsSql } from './mailbox-pointer-enter-state'

const HANDLE = 'term_retained'
const dirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function seedLegacyInbox(count: number): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pointer-work-legacy-'))
  dirs.push(dir)
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  dbs.push(db)
  const insert = db.db.prepare(
    `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, body)
     VALUES (?, 'run_legacy', 'legacy_direct', 'term_worker', ?, 'old', 'old')`
  )
  db.db.exec('BEGIN')
  for (let i = 0; i < count; i++) {
    insert.run(`msg_legacy_${i}`, HANDLE)
  }
  db.db.exec('COMMIT')
  return db
}

// Index entries each owed-work probe seeks through for the handle: the work the probe does.
function probedCandidates(db: OrchestrationDb): number {
  const sql = `SELECT 1 WHERE ${pointerWorkExistsSql('?')}`
  const indexes = db.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(HANDLE, HANDLE)
    .map((row) => /USING (?:COVERING )?INDEX (\w+)/.exec(String(row.detail))?.[1])
    .filter((name): name is string => !!name)
  expect(indexes.length).toBe(2)
  return indexes.reduce((total, name) => {
    const definition = String(
      db.db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name)?.sql
    )
    const partial = /\bWHERE\b([\s\S]*)$/i.exec(definition)?.[1] ?? '1'
    const row = db.db
      .prepare(
        `SELECT count(*) AS n FROM messages INDEXED BY ${name} WHERE to_handle = ? AND ${partial}`
      )
      .get(HANDLE) as { n: number }
    return total + row.n
  }, 0)
}

describe('owed pointer work with retained legacy mail', () => {
  it('does not seek through legacy inbox history', () => {
    for (const count of [1_000, 10_000]) {
      const db = seedLegacyInbox(count)
      expect(db.getMailboxesWithPointerWork([HANDLE]).size).toBe(0)
      expect(probedCandidates(db)).toBe(0)
    }
  })
})
