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

it('reads a Hermes conversation as chat items a chat can take over, tool calls on their own', () => {
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
