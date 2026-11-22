import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { readHermesChatTranscript } from './transcript-hermes-sqlite'

let dir: string | null = null

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = null
})

function createStore(): { path: string; db: Database } {
  dir = mkdtempSync(join(tmpdir(), 'orca-hermes-chat-'))
  const path = join(dir, 'state.db')
  const db = new Database(path)
  // Hermes v2026.3.12 (schema 4) columns, the oldest released store.
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, model_config TEXT,
      parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
  `)
  db.prepare("INSERT INTO sessions (id, source, started_at) VALUES ('s', 'cli', 1773300000)").run()
  return { path, db }
}

it('reads a Hermes conversation as chat items a chat can take over, tool calls on their own', () => {
  const { path, db } = createStore()
  const add = db.prepare(
    'INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  )
  add.run('s', 'user', 'list the files', null, null, 1773300001)
  add.run(
    's',
    'assistant',
    'Looking.',
    null,
    JSON.stringify([
      { id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls"}' } }
    ]),
    1773300002
  )
  add.run('s', 'tool', 'README.md', 'c1', null, 1773300003)
  db.close()

  expect(readHermesChatTranscript({ dbPath: path, sessionId: 's' })).toEqual([
    {
      id: 's:1',
      role: 'user',
      blocks: [{ type: 'text', text: 'list the files' }],
      timestamp: 1773300001000,
      source: 'transcript'
    },
    {
      id: 's:2:text',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Looking.' }],
      timestamp: 1773300002000,
      source: 'transcript'
    },
    {
      id: 's:2:call:0',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'terminal', input: { command: 'ls' }, callId: 'c1' }],
      timestamp: 1773300002000,
      source: 'transcript'
    },
    {
      id: 's:3',
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'README.md', callId: 'c1' }],
      timestamp: 1773300003000,
      source: 'transcript'
    }
  ])
  expect(readHermesChatTranscript({ dbPath: path, sessionId: 'missing' })).toBeNull()
})

it('reads a multimodal tool result as its text with images marked', () => {
  const { path, db } = createStore()
  const parts = [
    { type: 'text', text: 'Screenshot taken.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(100_000)}` } }
  ]
  db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_call_id, timestamp) VALUES ('s', 'tool', ?, 'c1', 1773300001)"
  ).run(`\u0000json:${JSON.stringify(parts)}`)
  db.close()

  expect(readHermesChatTranscript({ dbPath: path, sessionId: 's' })?.[0].blocks).toEqual([
    { type: 'tool-result', output: 'Screenshot taken.\n[image]', callId: 'c1' }
  ])
})

it('keeps the newest messages of a conversation too long to take over whole', () => {
  const { path, db } = createStore()
  const add = db.prepare(
    "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s', 'user', ?, ?)"
  )
  db.exec('BEGIN')
  for (let index = 1; index <= 400; index++) {
    add.run(`${index} ${'x'.repeat(100_000)}`, 1773300000 + index)
  }
  db.exec('COMMIT')
  db.close()

  const messages = readHermesChatTranscript({ dbPath: path, sessionId: 's' })!
  expect([messages.length, messages[0].id, messages.at(-1)?.id]).toEqual([383, 's:18', 's:400'])
  expect(messages[0].blocks[0]).toMatchObject({
    type: 'text',
    text: expect.stringMatching(/^18 x+$/)
  })
})
