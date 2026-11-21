import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const dirs: string[] = []
const dbs: OrchestrationDb[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of dbs.splice(0)) {
    db.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 50 Runs x 200 messages, interleaved, like a long-lived profile with ~48k messages.
function seedMessages(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-inbox-perf-'))
  dirs.push(dir)
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  dbs.push(db)
  const mail = db.db.prepare(
    `INSERT INTO messages (id, run_id, delivery_contract, from_handle, to_handle, subject, sequence)
     VALUES (?, ?, 'legacy_direct', 'term_a', 'term_b', 's', ?)`
  )
  db.db.exec('BEGIN')
  for (let seq = 1; seq <= 10_000; seq++) {
    mail.run(`msg_${seq}`, `run_${seq % 50}`, seq)
  }
  db.db.exec('COMMIT')
  db.db.exec('ANALYZE')
  return db
}

function capturePlans(db: OrchestrationDb, read: () => unknown): string[] {
  const sql: string[] = []
  const prepare = db.db.prepare.bind(db.db)
  vi.spyOn(db.db, 'prepare').mockImplementation((text: string) => {
    sql.push(text)
    return prepare(text)
  })
  read()
  vi.restoreAllMocks()
  return sql.flatMap((text) =>
    db.db
      .prepare(`EXPLAIN QUERY PLAN ${text}`)
      .all(...Array.from({ length: (text.match(/\?/g) ?? []).length }, () => null))
      .map((row) => String(row.detail))
  )
}

describe('getInbox', () => {
  it('reads one Run through its run/sequence index instead of scanning every message', () => {
    const db = seedMessages()
    const plan = capturePlans(db, () => db.getInbox(20, 'run_7'))
    expect(plan.filter((detail) => detail.includes('messages'))).toEqual([
      'SEARCH messages USING INDEX idx_messages_run_sequence (run_id=?)'
    ])
    expect(db.getInbox(3, 'run_7').map((row) => row.id)).toEqual([
      'msg_9957',
      'msg_9907',
      'msg_9857'
    ])
    expect(db.getInbox(2).map((row) => row.id)).toEqual(['msg_10000', 'msg_9999'])
  })
})
