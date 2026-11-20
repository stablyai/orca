import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { withFullFirstUserPromptCapture } from '../../prompts/session-scanner-first-user-prompt-capture'
import { readHermesConversation } from './hermes-state-db-conversations'
import { readMessageBodies, readMessageIdentities } from './hermes-state-db-messages'
import { readHermesSchema } from './hermes-state-db-schema'
import {
  captureHermesSqliteSession,
  listHermesSqliteSessions,
  parseHermesSqliteSession
} from './session-scanner-hermes-sqlite'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

// The columns Hermes 0.23 (schema 33) gives these tables that the scanner reads.
function createStateDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-state-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.db')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, session_key TEXT, model TEXT, model_config TEXT,
      parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
      message_count INTEGER DEFAULT 0, cwd TEXT, title TEXT, last_activity_at REAL,
      archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
      transcript_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
      reasoning TEXT, reasoning_content TEXT, active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0, display_metadata TEXT, message_uid TEXT,
      display_order INTEGER
    );
    CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  return { db, path }
}

type SessionFields = {
  id: string
  parent?: string
  startedAt: number
  endReason?: string
  endedAt?: number
  cwd?: string
  title?: string
  modelConfig?: Record<string, unknown>
  hidden?: boolean
  archived?: boolean
  sessionKey?: string
  source?: string
}

function addSession(db: Database.Database, session: SessionFields): void {
  db.prepare(
    `INSERT INTO sessions (id, source, session_key, model, model_config, parent_session_id,
       started_at, ended_at, end_reason, cwd, title, hidden, archived)
     VALUES (?, ?, ?, 'fake-model', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.source ?? 'cli',
    session.sessionKey ?? null,
    session.modelConfig ? JSON.stringify(session.modelConfig) : null,
    session.parent ?? null,
    session.startedAt,
    session.endedAt ?? null,
    session.endReason ?? null,
    session.cwd ?? null,
    session.title ?? null,
    session.hidden ? 1 : 0,
    session.archived ? 1 : 0
  )
}

function addMessage(
  db: Database.Database,
  message: {
    session: string
    role: string
    content?: string | null
    at: number
    active?: 0 | 1
    compacted?: 0 | 1
    toolCalls?: unknown
    displayMetadata?: Record<string, unknown>
    slot?: number
    uid?: string
  }
): void {
  db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, display_metadata, display_order, message_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    message.session,
    message.role,
    message.content ?? null,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    message.at,
    message.active ?? 1,
    message.compacted ?? 0,
    message.displayMetadata ? JSON.stringify(message.displayMetadata) : null,
    message.slot ?? null,
    message.uid ?? (message.slot === undefined ? null : `uid-${message.slot}`)
  )
}

function exchange(db: Database.Database, session: string, prompt: string, at: number): void {
  addMessage(db, { session, role: 'user', content: prompt, at })
  addMessage(db, { session, role: 'assistant', content: `Echo: ${prompt}`, at: at + 1 })
}

function listedIds(path: string, limit = 50): string[] {
  return listHermesSqliteSessions({ dbPaths: [path], limit, issues: [] }).map(
    (candidate) => candidate.file.path
  )
}

it('lists the conversations Hermes itself lists, newest first', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'cli', startedAt: 1_800_000_000, cwd: '/repo' })
  exchange(db, 'cli', 'first question', 1_800_000_010)
  addSession(db, { id: 'empty', startedAt: 1_800_000_500 })
  addSession(db, { id: 'hidden', startedAt: 1_800_000_100, hidden: true })
  exchange(db, 'hidden', 'bot mode', 1_800_000_110)
  addSession(db, { id: 'archived', startedAt: 1_800_000_200, archived: true })
  exchange(db, 'archived', 'old', 1_800_000_210)
  addSession(db, {
    id: 'subagent',
    parent: 'cli',
    startedAt: 1_800_000_020,
    modelConfig: { _delegate_from: 'cli' }
  })
  exchange(db, 'subagent', 'delegated task', 1_800_000_030)
  addSession(db, {
    id: 'branch',
    parent: 'cli',
    startedAt: 1_800_000_300,
    modelConfig: { _branched_from: 'cli' }
  })
  exchange(db, 'branch', 'branched question', 1_800_000_310)
  addSession(db, { id: 'third-party', startedAt: 1_800_000_400, source: 'tool' })
  exchange(db, 'third-party', 'tool run', 1_800_000_410)
  db.close()

  expect(listedIds(path)).toEqual([`${path}#branch`, `${path}#cli`])
  // A limited list reads only the most recent session rows; it must agree with the whole sweep.
  expect(listedIds(path, 1)).toEqual([`${path}#branch`])
  expect(listedIds(path, Infinity)).toEqual(listedIds(path))
})

it('finds an older conversation behind more recent sessions Hermes does not list', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'visible', startedAt: 1_800_000_000, cwd: '/repo' })
  exchange(db, 'visible', 'plan the release', 1_800_000_010)
  for (let index = 0; index < 60; index++) {
    const id = `subagent-${index}`
    addSession(db, {
      id,
      parent: 'visible',
      startedAt: 1_800_001_000 + index,
      modelConfig: { _delegate_from: 'visible' }
    })
    exchange(db, id, 'delegated task', 1_800_001_000 + index)
  }
  db.close()

  expect(listedIds(path, 1)).toEqual([`${path}#visible`])
})

it('reads a compressed conversation as one row through the continuation Hermes resumes', () => {
  const { db, path } = createStateDb()
  addSession(db, {
    id: 'root',
    startedAt: 1_800_000_000,
    endReason: 'compression',
    endedAt: 1_800_000_050,
    cwd: '/repo',
    title: 'Fix the parser'
  })
  exchange(db, 'root', 'before compression', 1_800_000_010)
  addSession(db, { id: 'tip', parent: 'root', startedAt: 1_800_000_050 })
  exchange(db, 'tip', 'after compression', 1_800_000_060)
  // A closed duplicate continuation from a reconnect; Hermes resumes the open one.
  addSession(db, {
    id: 'stale',
    parent: 'root',
    startedAt: 1_800_000_051,
    endedAt: 1_800_000_052,
    endReason: 'agent_close'
  })
  exchange(db, 'stale', 'abandoned branch', 1_800_000_051)
  db.close()

  const [candidate] = listHermesSqliteSessions({ dbPaths: [path], limit: 50, issues: [] })
  expect(candidate.file.path).toBe(`${path}#root`)
  expect(candidate.file.modifiedAt).toBe(new Date(1_800_000_061_000).toISOString())
  const session = parseHermesSqliteSession({ dbPath: path, sessionId: 'root', platform: 'darwin' })
  expect(session).toMatchObject({
    sessionId: 'root',
    title: 'Fix the parser',
    cwd: '/repo',
    messageCount: 4,
    filePath: `${path}#root`,
    resumeCommand: "cd '/repo' && hermes -p default --resume 'root'"
  })
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'before compression',
    'Echo: before compression',
    'after compression',
    'Echo: after compression'
  ])
})

it('paints what Hermes displays after an in-place compaction, without rewound or model-only rows', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'chat', startedAt: 1_800_000_000 })
  const original = { session: 'chat', active: 0 as const, compacted: 1 as const }
  addMessage(db, { ...original, role: 'user', content: 'first', at: 1_800_000_001, slot: 1 })
  addMessage(db, {
    ...original,
    role: 'assistant',
    content: null,
    at: 1_800_000_002,
    slot: 2,
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls"}' } }
    ]
  })
  addMessage(db, { ...original, role: 'tool', content: 'README.md', at: 1_800_000_003, slot: 3 })
  addMessage(db, { ...original, role: 'assistant', content: 'Done.', at: 1_800_000_004, slot: 4 })
  addMessage(db, {
    session: 'chat',
    role: 'user',
    content: 'rewound',
    at: 1_800_000_005,
    active: 0
  })
  // Compaction keeps a live copy of the tail in the same slot and adds its summary.
  addMessage(db, { session: 'chat', role: 'user', content: 'first', at: 1_800_000_001, slot: 1 })
  addMessage(db, {
    session: 'chat',
    role: 'assistant',
    content: 'Summary of the chat',
    at: 1_800_000_006,
    slot: 6
  })
  addMessage(db, {
    session: 'chat',
    role: 'assistant',
    content: 'Done.',
    at: 1_800_000_004,
    slot: 4
  })
  addMessage(db, {
    session: 'chat',
    role: 'user',
    content: 'model-only',
    at: 1_800_000_007,
    displayMetadata: { model_only: true }
  })
  db.close()

  const { session, messages } = captureHermesSqliteSession({
    dbPath: path,
    sessionId: 'chat',
    platform: 'darwin'
  })
  expect(session).toMatchObject({ title: 'first', messageCount: 4 })
  expect(messages.map(({ role, text }) => [role, text])).toEqual([
    ['user', 'first'],
    ['tool', 'terminal: ls'],
    ['tool', 'README.md'],
    ['assistant', 'Done.'],
    ['assistant', 'Summary of the chat']
  ])
})

it('names a local reset lineage by its owner and lists only its newest segment', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'local-a', startedAt: 1_800_000_000, endReason: 'session_reset' })
  exchange(db, 'local-a', 'before reset', 1_800_000_010)
  addSession(db, {
    id: 'local-b',
    parent: 'local-a',
    startedAt: 1_800_000_100,
    modelConfig: { _reset_from: 'local-a' }
  })
  exchange(db, 'local-b', 'after reset', 1_800_000_110)
  db.prepare('INSERT INTO state_meta (key, value) VALUES (?, ?)').run(
    'gateway.local_policy.v1:local-a',
    JSON.stringify({ session_id: 'local-a', lineage: ['local-a', 'local-b'] })
  )
  db.close()

  expect(listedIds(path)).toEqual([`${path}#local-a`])
  const session = parseHermesSqliteSession({
    dbPath: path,
    sessionId: 'local-a',
    platform: 'darwin'
  })
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'after reset',
    'Echo: after reset'
  ])
})

it('moves the row revision on a rewind or a retitle that leaves every timestamp alone', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'chat', startedAt: 1_800_000_000 })
  exchange(db, 'chat', 'one', 1_800_000_010)
  exchange(db, 'chat', 'two', 1_800_000_020)
  const revision = () =>
    listHermesSqliteSessions({ dbPaths: [path], limit: 50, issues: [] })[0].file.sizeBytes
  const first = revision()
  db.prepare("UPDATE messages SET active = 0 WHERE content LIKE '%two'").run()
  const rewound = revision()
  db.prepare("UPDATE sessions SET title = 'Renamed' WHERE id = 'chat'").run()
  const renamed = revision()
  const retitle = db.prepare("UPDATE sessions SET title = ? WHERE id = 'chat'")
  retitle.run('Plan \u{1F600}')
  const grinning = revision()
  retitle.run('Plan \u{1F601}')
  const beaming = revision()
  db.close()

  expect(new Set([first, rewound, renamed, grinning, beaming]).size).toBe(5)
})

it('keeps a message rewound in a continuation hidden, and a compacted tool result whole', () => {
  const { db, path } = createStateDb()
  addSession(db, {
    id: 'root',
    startedAt: 1_800_000_000,
    endReason: 'compression',
    endedAt: 1_800_000_050
  })
  addMessage(db, { session: 'root', role: 'user', content: 'ask', at: 1_800_000_001, slot: 1 })
  addMessage(db, {
    session: 'root',
    role: 'tool',
    content: 'full output',
    at: 1_800_000_002,
    slot: 2,
    active: 0,
    compacted: 1
  })
  addMessage(db, {
    session: 'root',
    role: 'tool',
    content: '[truncated]',
    at: 1_800_000_002,
    slot: 5,
    uid: 'uid-2'
  })
  addMessage(db, {
    session: 'root',
    role: 'assistant',
    content: 'undone answer',
    at: 1_800_000_003,
    slot: 3
  })
  addSession(db, { id: 'tip', parent: 'root', startedAt: 1_800_000_050 })
  // Rotation carries the tail into the continuation under the same message_uid; then it is rewound.
  addMessage(db, {
    session: 'tip',
    role: 'assistant',
    content: 'undone answer',
    at: 1_800_000_003,
    slot: 3,
    active: 0
  })
  // Display slots number each segment on its own; slot 1 here is not the parent's slot 1.
  addMessage(db, {
    session: 'tip',
    role: 'user',
    content: 'next',
    at: 1_800_000_060,
    slot: 1,
    uid: 'uid-next'
  })
  db.close()

  const { messages } = captureHermesSqliteSession({
    dbPath: path,
    sessionId: 'root',
    platform: 'darwin'
  })
  expect(messages.map(({ role, text }) => [role, text])).toEqual([
    ['user', 'ask'],
    ['tool', 'full output'],
    ['user', 'next']
  ])
})

it('names an untitled conversation from a multimodal first prompt longer than the preview cut', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'chat', startedAt: 1_800_000_000 })
  const parts = [
    { type: 'text', text: 'Describe this screenshot' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20_000)}` } }
  ]
  addMessage(db, {
    session: 'chat',
    role: 'user',
    content: `\u0000json:${JSON.stringify(parts)}`,
    at: 1_800_000_010
  })
  const schema = readHermesSchema(db, path)!
  const rows = readMessageIdentities(db, schema, readHermesConversation(db, schema, 'chat')!)
  for (const options of [{ full: false }, { full: true, textChars: 100 }, { full: true }]) {
    const [row] = readMessageBodies(db, schema, rows, { ...options, tools: false })
    // The image's base64 stays in SQLite; its part keeps its place.
    expect(row.content).toBe(`\u0000json:${JSON.stringify([parts[0], { type: 'image_url' }])}`)
  }
  db.close()

  const session = parseHermesSqliteSession({ dbPath: path, sessionId: 'chat', platform: 'darwin' })
  expect(session?.title).toBe('Describe this screenshot')
})

it('shows nothing of a cut multimodal first prompt whose parts do not parse', () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'chat', startedAt: 1_800_000_000 })
  addMessage(db, {
    session: 'chat',
    role: 'user',
    content: `\u0000json:[{"type":"text","text":"${'A'.repeat(20_000)}"`,
    at: 1_800_000_010
  })
  db.close()

  const session = parseHermesSqliteSession({ dbPath: path, sessionId: 'chat', platform: 'darwin' })
  expect(session?.title).toBe('Hermes chat')
  expect(session?.previewMessages).toEqual([])
})

it('reads a whole first prompt longer than the preview cut', async () => {
  const { db, path } = createStateDb()
  addSession(db, { id: 'chat', startedAt: 1_800_000_000 })
  exchange(db, 'chat', 'x'.repeat(20_000), 1_800_000_010)
  db.close()

  const prompt = await withFullFirstUserPromptCapture(
    async () =>
      parseHermesSqliteSession({ dbPath: path, sessionId: 'chat', platform: 'darwin' })
        ?.firstUserPrompt
  )
  expect(prompt).toHaveLength(20_000)
})

it('reads the oldest released store, which has no cwd, visibility or display columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-state-'))
  tempDirs.push(dir)
  const path = join(dir, 'state.db')
  const db = new Database(path)
  // Hermes v2026.3.12, schema 4.
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT,
      model_config TEXT, system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
      ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
      token_count INTEGER, finish_reason TEXT);
  `)
  db.prepare(
    "INSERT INTO sessions (id, source, model, started_at, title) VALUES ('old', 'cli', 'm', 1773300000, 'Old chat')"
  ).run()
  db.prepare(
    "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('old', 'user', 'hi', 1773300001), ('old', 'assistant', 'hello', 1773300002)"
  ).run()
  db.close()

  expect(listedIds(path)).toEqual([`${path}#old`])
  expect(
    parseHermesSqliteSession({ dbPath: path, sessionId: 'old', platform: 'linux' })
  ).toMatchObject({ title: 'Old chat', messageCount: 2, cwd: null })
})
