import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const PTY = 'pty-1'
const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

// Uncertain claims a working terminal keeps, plus one reservation and one read row it may release.
function seed(retained: number): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const insert = db.db.prepare(
    `INSERT INTO messages (id, delivery_contract, from_handle, to_handle, subject, body, read,
       pointer_enter_pending, pointer_pty_id, pointer_process_incarnation)
     VALUES (?, 'current_delivery', 'term_worker', 'run:shared', 's', 'b', ?, ?, ?, 'incarnation-1')`
  )
  db.db.exec('BEGIN')
  for (let index = 0; index < retained; index++) {
    insert.run(`msg_retained_${index}`, 0, 3, PTY)
  }
  insert.run('msg_reserved', 0, 1, PTY)
  insert.run('msg_read', 1, 2, PTY)
  db.db.exec('COMMIT')
  return db
}

// Rows each update's index range holds for the PTY: what one working-title frame walks.
function rangeRows(db: OrchestrationDb, sql: string): number {
  const name = /INDEXED BY (\w+)/.exec(sql)?.[1] ?? ''
  expect(name).not.toBe('')
  const definition = String(
    db.db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name)?.sql
  )
  const partial = /\bWHERE\b([\s\S]*)$/i.exec(definition)?.[1] ?? '1'
  return Number(
    db.db
      .prepare(
        `SELECT count(*) AS n FROM messages INDEXED BY ${name} WHERE pointer_pty_id = ? AND ${partial}`
      )
      .get(PTY)?.n
  )
}

it('a working-title release walks only releasable rows, never the retained uncertain claims', () => {
  for (const retained of [1_000, 10_000]) {
    const db = seed(retained)
    const prepare = vi.spyOn(db.db, 'prepare')
    db.releasePendingMailboxPointerForPty(PTY)
    const updates = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('UPDATE'))
    prepare.mockRestore()
    expect(updates).toHaveLength(2)
    const before = seed(retained)
    expect(updates.map((sql) => rangeRows(before, sql))).toEqual([1, 1])
    expect(db.getMessageById('msg_reserved')).toMatchObject({ pointer_enter_pending: 0 })
    expect(db.getMessageById('msg_read')).toMatchObject({ pointer_enter_pending: 0 })
    expect(db.getMessageById('msg_retained_0')).toMatchObject({ pointer_enter_pending: 3 })
    db.releasePendingMailboxPointerForPty(PTY)
  }
})
