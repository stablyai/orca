import { describe, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import {
  readAgentSessionBackgroundMeta,
  writeAgentSessionBackgroundMeta
} from './agent-session-background-meta'

function openMeta(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agent_session_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

const keys = (db: Database.Database) =>
  db
    .prepare('SELECT key FROM agent_session_store_meta ORDER BY key')
    .all()
    .map((row) => String(row.key))

describe('ended chats on disk', () => {
  it('writes one row per chat ended and deletes one per chat reopened, touching no other', () => {
    const db = openMeta()
    const write = (ended: { add: string[]; remove: string[] }) =>
      writeAgentSessionBackgroundMeta(db, { background: null, backgroundBackfilled: false, ended })

    write({ add: ['a', 'b'], remove: [] })
    db.prepare(
      "INSERT INTO agent_session_store_meta (key, value) VALUES ('ended_session;x', '1')"
    ).run()
    write({ add: ['c'], remove: ['a'] })

    expect(keys(db)).toEqual(['ended_session:b', 'ended_session:c', 'ended_session;x'])
    expect(readAgentSessionBackgroundMeta(db).ended).toEqual(['b', 'c'])
  })
})
