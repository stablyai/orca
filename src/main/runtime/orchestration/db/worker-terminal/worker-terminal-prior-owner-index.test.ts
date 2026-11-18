import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function openFileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-prior-owner-'))
  dirs.push(dir)
  return join(dir, 'orchestration.db')
}

// Raw SQL, as an older build that knows nothing of the index writes it.
function writeResource(
  db: OrchestrationDb,
  id: string,
  owner: string,
  priors: string[],
  at: string
) {
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, terminal_handle, updated_at)
       VALUES (?, ?, ?, ?, 'term', ?)`
    )
    .run(id, priors[0] ?? owner, owner, JSON.stringify(priors), at)
}

const formerOf = (db: OrchestrationDb, dispatchId: string) =>
  db.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)?.id

describe('former owner lookup', () => {
  it('backfills a file written before the index and keeps it current under raw writes', () => {
    const path = openFileDb()
    const first = new OrchestrationDb(path)
    first.db.exec(`
      DROP TRIGGER trg_worker_terminal_prior_owners_insert;
      DROP TRIGGER trg_worker_terminal_prior_owners_update;
      DROP TRIGGER trg_worker_terminal_prior_owners_delete;
      DROP TABLE worker_terminal_resource_prior_owners;
    `)
    writeResource(first, 'wtr_old', 'd_3', ['d_1', 'd_2'], '2026-01-01 00:00:00')
    writeResource(first, 'wtr_new', 'd_5', ['d_1', 'd_4'], '2026-01-02 00:00:00')
    first.close()

    const db = new OrchestrationDb(path)
    expect(formerOf(db, 'd_1')).toBe('wtr_new')
    expect(formerOf(db, 'd_2')).toBe('wtr_old')
    expect(formerOf(db, 'd_3')).toBeUndefined()

    db.db
      .prepare(
        `UPDATE worker_terminal_resources SET owner_dispatch_id = 'd_6',
           prior_owner_dispatch_ids = '["d_1","d_2","d_3"]', updated_at = '2026-01-03 00:00:00'
         WHERE id = 'wtr_old'`
      )
      .run()
    expect(formerOf(db, 'd_3')).toBe('wtr_old')
    expect(formerOf(db, 'd_1')).toBe('wtr_old')

    db.db.prepare("DELETE FROM worker_terminal_resources WHERE id = 'wtr_old'").run()
    expect(formerOf(db, 'd_2')).toBeUndefined()
    expect(formerOf(db, 'd_1')).toBe('wtr_new')
    db.close()
  })

  it('matches the exact Dispatch id, not a LIKE pattern over the JSON text', () => {
    const db = new OrchestrationDb(':memory:')
    writeResource(db, 'wtr_other', 'd_9', ['dX1', 'D_1'], '2026-01-01 00:00:00')
    expect(formerOf(db, 'd_1')).toBeUndefined()
    db.close()
  })

  it('reads one index range instead of scanning every resource', () => {
    const db = new OrchestrationDb(':memory:')
    const prepare = db.db.prepare.bind(db.db)
    const queries: string[] = []
    const spy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
      queries.push(sql)
      return prepare(sql)
    })
    formerOf(db, 'd_1')
    spy.mockRestore()
    const plan = prepare(`EXPLAIN QUERY PLAN ${queries[0]}`)
      .all('d_1')
      .map((row) => String(row.detail))
    expect(plan.filter((detail) => detail.startsWith('SCAN'))).toEqual([])
    db.close()
  })
})
