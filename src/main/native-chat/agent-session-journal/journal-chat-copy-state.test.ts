import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { readJournalSqlDatabase } from './journal-sql-database-read'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('lets a cleanup delete only chats with nothing left to copy in', () => {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  const state = db.prepare(
    'INSERT INTO journal_chat_state(session_id,workspace_id,epoch) VALUES(?,?,?)'
  )
  state.run('copied', 'repo::/w/a', 'epoch-1')
  // An older Orca's chat this store is still converting: deleting it now would skip its copy.
  state.run('converting', 'repo::/w/a', null)
  const copyState = (sessionId: string) => {
    const read = readJournalSqlDatabase(db, { kind: 'chat-copy-state', sessionId })
    return read.kind === 'chat-copy-state' ? read.state : null
  }
  expect(copyState('copied')).toBe('copied')
  expect(copyState('converting')).toBe('pending')
  expect(copyState('never-opened')).toBe('absent')
})
