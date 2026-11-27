import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { captureOpenCode2SqliteSession } from '../../../ai-vault/scanners/opencode2/session-scanner-opencode2-sqlite'
import {
  readOpenCode2TranscriptPage,
  readOpenCode2TranscriptSignal
} from './transcript-opencode2-sqlite'

const SESSION = 'ses_1'
const PARTS = [
  { type: 'reasoning', text: 'Looking at the file.' },
  {
    type: 'tool',
    id: 'call_1',
    name: 'read',
    state: {
      status: 'completed',
      input: { path: 'notes.txt' },
      content: [{ type: 'text', text: 'hello world' }]
    }
  },
  { type: 'text', text: 'It says hello world.' }
]

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** One conversation as OpenCode 2.3 (parts inline) or 2.4+ (parts in session_part) stores it. */
async function writeSession(shape: '2.3' | '2.4'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opencode2-parts-'))
  roots.push(root)
  const path = join(root, 'opencode.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO session_v2 VALUES (?, '/tmp/p', 'Title', 1, 5)").run(SESSION)
  const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
  message.run('msg_u', SESSION, 'user', 1, 1, 1, JSON.stringify({ text: 'What is in notes.txt?' }))
  message.run(
    'msg_s',
    SESSION,
    'system',
    2,
    2,
    2,
    JSON.stringify({ text: 'New instructions apply from: AGENTS.md', description: 'Instructions' })
  )
  message.run(
    'msg_a',
    SESSION,
    'assistant',
    3,
    3,
    3,
    JSON.stringify({ content: shape === '2.3' ? PARTS : [] })
  )
  message.run('msg_i', SESSION, 'idle', 4, 4, 4, JSON.stringify({ outcome: 'succeeded' }))
  if (shape === '2.4') {
    db.exec(`CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal))`)
    const part = db.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, NULL, 3, ?, ?)')
    // Inserted out of order: ordinal, not insertion order, decides the sequence.
    for (const ordinal of [2, 0, 1]) {
      part.run(
        'msg_a',
        SESSION,
        ordinal,
        PARTS[ordinal].type,
        10 + ordinal,
        JSON.stringify(PARTS[ordinal])
      )
    }
  }
  db.close()
  return path
}

function readPage(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    return readOpenCode2TranscriptPage(db, { sessionId: SESSION, limit: 50 })?.items.map(
      ({ message }) => ({ id: message.id, role: message.role, blocks: message.blocks })
    )
  } finally {
    db.close()
  }
}

const EXPECTED_PAGE = [
  {
    id: 'opencode:msg_u',
    role: 'user',
    blocks: [{ type: 'text', text: 'What is in notes.txt?' }]
  },
  {
    id: 'opencode:msg_a:reasoning',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Looking at the file.' }]
  },
  {
    id: 'opencode:msg_a',
    role: 'assistant',
    blocks: [
      expect.objectContaining({ type: 'tool-call', name: 'read' }),
      expect.objectContaining({ type: 'tool-result' }),
      { type: 'text', text: 'It says hello world.' }
    ]
  }
]

it('reads 2.4 session_part rows exactly as 2.3 inline parts, and never shows system rows', async () => {
  expect(readPage(await writeSession('2.3'))).toEqual(EXPECTED_PAGE)
  expect(readPage(await writeSession('2.4'))).toEqual(EXPECTED_PAGE)
})

it('gives Session History the same assistant text from both shapes', async () => {
  for (const shape of ['2.3', '2.4'] as const) {
    const { messages } = await captureOpenCode2SqliteSession({
      dbPath: await writeSession(shape),
      sessionId: SESSION,
      platform: 'darwin'
    })
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'What is in notes.txt?' },
      { role: 'assistant', text: 'Looking at the file.\nIt says hello world.' },
      { role: 'tool', text: 'read: notes.txt' },
      { role: 'tool', text: 'hello world' }
    ])
  }
})

it('signals part changes so a streaming 2.4 reply refreshes', async () => {
  const db = new Database(await writeSession('2.4'), { readonly: true })
  try {
    expect(readOpenCode2TranscriptSignal(db, SESSION)).toMatchObject({
      partCount: 3,
      maxPartTimeUpdated: 12
    })
  } finally {
    db.close()
  }
})
