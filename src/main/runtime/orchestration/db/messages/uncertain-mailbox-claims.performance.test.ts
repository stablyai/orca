import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { hasUncertainMailboxClaims } from './uncertain-mailbox-claims'

const MAILBOX = 'run:shared'
const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

// Former terminals' uncertain claims in a shared Run mailbox, plus one of this terminal's own.
function seed(formerClaims: number): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const insert = db.db.prepare(
    `INSERT INTO messages (id, delivery_contract, from_handle, to_handle, subject, body,
       pointer_enter_pending, pointer_pty_id, pointer_process_incarnation)
     VALUES (?, 'current_delivery', 'term_worker', ?, 's', 'b', 3, ?, 'incarnation-1')`
  )
  db.db.exec('BEGIN')
  for (let index = 0; index < formerClaims; index++) {
    insert.run(`msg_former_${index}`, MAILBOX, `pty-former-${index % 10}`)
  }
  insert.run('msg_own', MAILBOX, 'pty-1')
  db.db.exec('COMMIT')
  return db
}

it("checking one terminal's uncertain mail seeks only that terminal's claims in a shared mailbox", () => {
  for (const formerClaims of [1_000, 10_000]) {
    const db = seed(formerClaims)
    const prepare = vi.spyOn(db.db, 'prepare')
    const claim = { ptyId: 'pty-1', mailbox: MAILBOX, incarnation: 'incarnation-1' }
    expect(hasUncertainMailboxClaims(db, { ...claim, staged: new Set() })).toBe(true)
    expect(hasUncertainMailboxClaims(db, { ...claim, staged: new Set(['msg_own']) })).toBe(false)
    const sql = String(prepare.mock.calls[0]?.[0])
    prepare.mockRestore()
    const plan = db.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('pty-1', MAILBOX, 'incarnation-1', 1)
      .map((row) => String(row.detail))
    expect(plan).toEqual([
      expect.stringContaining(
        '(pointer_pty_id=? AND to_handle=? AND pointer_process_incarnation=?)'
      )
    ])
  }
})
