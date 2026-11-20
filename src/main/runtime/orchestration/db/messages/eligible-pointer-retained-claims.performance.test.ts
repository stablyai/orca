import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const HANDLE = 'term_retained'
const dbs: OrchestrationDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close()
  }
})

// Uncertain claims a terminal kept after lost write acknowledgements, plus one message it may announce now.
function seed(retained: number): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  dbs.push(db)
  const insert = db.db.prepare(
    `INSERT INTO messages (id, delivery_contract, from_handle, to_handle, subject, body,
       pointer_enter_pending, pointer_pty_id, pointer_process_incarnation)
     VALUES (?, 'current_delivery', 'term_worker', ?, 's', 'b', ?, 'pty-1', 'incarnation-1')`
  )
  db.db.exec('BEGIN')
  for (let index = 0; index < retained; index++) {
    insert.run(`msg_retained_${index}`, HANDLE, 3)
  }
  insert.run('msg_eligible', HANDLE, 0)
  db.db.exec('COMMIT')
  return db
}

// Rows the query's index range holds for the handle: what each delivery's selection walks.
function indexCandidates(db: OrchestrationDb, sql: string): number {
  const name = /INDEXED BY (\w+)/.exec(sql)?.[1]
  expect(name).toBeDefined()
  const definition = String(
    db.db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name)?.sql
  )
  const partial = /\bWHERE\b([\s\S]*)$/i.exec(definition)?.[1] ?? '1'
  return Number(
    db.db
      .prepare(
        `SELECT count(*) AS n FROM messages INDEXED BY ${name} WHERE to_handle = ? AND ${partial}`
      )
      .get(HANDLE)?.n
  )
}

it('selecting deliverable mail walks none of the retained uncertain claims', () => {
  for (const retained of [1_000, 10_000]) {
    const db = seed(retained)
    const prepare = vi.spyOn(db.db, 'prepare')
    const eligible = db.getUndeliveredUnreadMessages(HANDLE, undefined, { limit: 50 })
    expect(eligible.map((message) => message.id)).toEqual(['msg_eligible'])
    const sql = String(
      prepare.mock.calls.find(([text]) => String(text).includes('ORDER BY sequence'))?.[0]
    )
    prepare.mockRestore()
    expect(indexCandidates(db, sql)).toBe(1)
  }
})
