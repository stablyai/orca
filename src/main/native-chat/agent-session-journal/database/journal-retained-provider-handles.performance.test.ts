import { expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { JOURNAL_DOMAIN_SCHEMA_001 } from './journal-domain-schema-001'
import { migrateJournalDomainSchema } from './journal-domain-migrations'
import { runJournalTransaction } from './journal-database'
import {
  ensureJournalRetainedProviderHandles,
  journalProviderHandleOwners
} from './journal-retained-provider-handles'

it('looks up an earlier native handle by index regardless of saved chat count', () => {
  const record = (id: string, inactive?: string) =>
    JSON.stringify({
      providerHandleChain: [{ handle: { threadId: id } }],
      ...(inactive ? { inactiveProviderHandleLinks: [{ handle: { sessionId: inactive } }] } : {})
    })

  const measure = (chats: number) => {
    const db = new Database(':memory:')
    try {
      db.exec(JOURNAL_DOMAIN_SCHEMA_001)
      db.pragma('user_version = 2')
      const put = db.prepare(`INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)
        ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json`)
      db.exec('BEGIN')
      for (let index = 0; index < chats; index++) {
        put.run(`chat-${index}`, record(`thread-${index}`, `retired-${index}`))
      }
      put.run('first', record('newer', 'original'))
      db.exec('COMMIT')
      migrateJournalDomainSchema(db)
      ensureJournalRetainedProviderHandles(db, (run) => runJournalTransaction(db, run))
      expect(journalProviderHandleOwners(db, 'original')).toEqual(['first'])
      expect(journalProviderHandleOwners(db, 'newer')).toEqual(['first'])

      // Released builds write the same record columns. Those writes and rollbacks also update the index.
      db.exec('BEGIN')
      put.run('first', record('newer', 'changed'))
      expect(journalProviderHandleOwners(db, 'original')).toEqual([])
      expect(journalProviderHandleOwners(db, 'changed')).toEqual(['first'])
      db.exec('ROLLBACK')
      put.run('second', record('original'))

      const prepare = db.prepare.bind(db)
      let matches = 0
      db.function('inspected_owner', (sessionId) => {
        matches++
        return sessionId
      })
      db.prepare = (sql) => {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all('original', 'original')
        expect(plan.map(({ detail }) => String(detail))).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              'SEARCH agent_session_records USING INDEX agent_session_records_adopted_native'
            ),
            expect.stringContaining(
              'SEARCH journal_retained_provider_handles USING COVERING INDEX journal_retained_provider_handles_native'
            )
          ])
        )
        expect(plan.some(({ detail }) => String(detail).includes('SCAN'))).toBe(false)
        return prepare(sql.replaceAll('= ?', '= ? AND inspected_owner(session_id) IS NOT NULL'))
      }
      expect(journalProviderHandleOwners(db, 'original')).toEqual(['first', 'second'])
      return matches
    } finally {
      db.close()
    }
  }

  expect([measure(10_000), measure(100_000)]).toEqual([2, 2])
})
