import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import { readOpenCodeTranscriptPage } from './transcript-opencode-sqlite-query'

const fixtures: { db: Database.Database; root: string }[] = []
afterEach(() => {
  for (const { db, root } of fixtures.splice(0)) {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-opencode2-'))
  const path = join(root, 'opencode.db')
  const db = new Database(path)
  fixtures.push({ db, root })
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('session');
    ALTER TABLE session_v2 ADD COLUMN directory TEXT;
    UPDATE session_v2 SET directory = '/folder';`)
  const insertMessage = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
  let sequence = 0
  const insert = (id: string, type: string, data: unknown, time = 1) =>
    insertMessage.run(id, 'session', type, ++sequence, JSON.stringify(data), time, time)
  return { path, insert }
}

it.each([true, false])(
  'uses genuine v2 idle evidence for the imported latest root, completed: %s',
  async (completed) => {
    const { path, insert } = fixture()
    insert('u1', 'user', { text: 'First prompt' })
    insert('a1', 'assistant', { content: [{ type: 'text', text: 'First response' }] })
    insert('idle1', 'idle', { outcome: 'succeeded' })
    insert('u2', 'user', { text: 'Latest prompt' })
    insert('a2', 'assistant', { content: [{ type: 'text', text: 'Latest prose' }] })
    if (completed) {
      insert('idle2', 'idle', { outcome: 'succeeded' })
    }
    const imported = await readOpenCodeNativeChatTranscriptFull('session', {
      resolveDbPath: async () => path,
      readPage: async (args) => readOpenCodeTranscriptPage(args)
    })
    expect(imported).toMatchObject({
      forkTipItemIds: completed ? ['opencode:u2', 'opencode:a2', 'opencode:idle2'] : []
    })
  }
)
