import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { JournalSqlScope } from './journal-sql-scope'
import { sqlJournalStatusItems } from './journal-sql-status-items'

// Perf contract for STA-17086: a quiet bot chat's per-turn prose lookup seeks its turn instead of
// walking the chat's whole prose history (SQLite has no stats here, so it never picks this itself).

const databases: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('looks up one turn’s prose through the turn index', () => {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  const statements: string[] = []
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    statements.push(sql)
    return prepare(sql)
  })
  const scope = new JournalSqlScope(db, 'chat', 'epoch')
  const selection = { kind: 'assistant-prose', floor: 0, turnItemId: 'turn' } as const
  expect([...sqlJournalStatusItems(scope, () => undefined, selection)]).toEqual([])

  const [sql] = statements
  const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all('chat', 'epoch', 'turn', 128)
  expect(plan.map((step) => String(step.detail)).join('\n')).toContain(
    'USING INDEX journal_items_stop_turn (session_id=? AND epoch=? AND turn_item_id=?)'
  )
})
