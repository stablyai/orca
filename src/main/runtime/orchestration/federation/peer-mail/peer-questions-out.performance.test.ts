import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { SETTLE_OLDEST_IN_THREAD_SQL, THREAD_SETTLED_UNNAMED_SQL } from './peer-questions-out'

// #49521: an older Orca's reply and an unpair each read one index seek, never settled history.
describe('paired-question lookups by thread', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  const plan = (sql: string) =>
    db.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('conversation', 'thread')
      .map((row) => String(row.detail))

  it('seeks the thread index for a reply that names no question, and for an unpair', () => {
    expect(plan(SETTLE_OLDEST_IN_THREAD_SQL)).toEqual([
      'SEARCH peer_questions_out USING INTEGER PRIMARY KEY (rowid=?)',
      'SCALAR SUBQUERY 1',
      'SEARCH peer_questions_out USING COVERING INDEX idx_peer_questions_out_thread (conversation_id=? AND <expr>=? AND awaiting=?)'
    ])
    expect(plan(THREAD_SETTLED_UNNAMED_SQL)).toEqual([
      'SEARCH peer_questions_out USING COVERING INDEX idx_peer_questions_out_thread (conversation_id=? AND <expr>=? AND awaiting=?)'
    ])
  })
})
