import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canReadOpenCodeChatSession,
  mapOpenCodeNativeChatMessages,
  openCodeMessageSignature,
  readOpenCodeNativeChatTranscriptTail,
  isRetryableOpenCodeSqliteError
} from './opencode-sqlite-transcript'
import SyncDatabase from '../sqlite/sync-database'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(): { db: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-native-chat-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new DatabaseSync(path), path }
}

function openSchemaCheckDatabase(path: string): SyncDatabase {
  return new SyncDatabase(path, { readonly: true })
}

function applyOpenCodeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
}

function insertSession(db: DatabaseSync, id: string, timeCreated = 1_777_634_000_000): void {
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated)
     VALUES (?, 'project-1', NULL, '/work', 'Session', ?, ?)`
  ).run(id, timeCreated, timeCreated)
}

function insertMessage(
  db: DatabaseSync,
  args: { id: string; sessionId: string; role: 'user' | 'assistant'; timeCreated: number }
): void {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.sessionId,
    args.timeCreated,
    args.timeCreated,
    JSON.stringify({ role: args.role, time: { created: args.timeCreated } })
  )
}

function insertPart(
  db: DatabaseSync,
  args: {
    id: string
    messageId: string
    sessionId: string
    timeCreated: number
    data: string
  }
): void {
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(args.id, args.messageId, args.sessionId, args.timeCreated, args.timeCreated, args.data)
}

const toolData = (status: 'pending' | 'completed' | 'error', tool = 'bash'): string =>
  JSON.stringify({
    type: 'tool',
    tool,
    callID: 'call_1',
    state: {
      status,
      input: { command: 'ls' },
      ...(status === 'completed' ? { output: 'a.txt\nb.ts' } : {}),
      ...(status === 'error' ? { error: 'command failed' } : {})
    }
  })

describe('mapOpenCodeNativeChatMessages', () => {
  it('maps a user text prompt with a stable id and timestamp', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_1', time_created: 1_777_634_000_500, data: JSON.stringify({ role: 'user' }) },
      [
        {
          id: 'part_1',
          message_id: 'msg_1',
          time_created: 1_777_634_000_500,
          data: JSON.stringify({ type: 'text', text: 'Plan the work' })
        }
      ]
    )?.[0]
    expect(message).toMatchObject({
      id: 'msg_1',
      role: 'user',
      timestamp: 1_777_634_000_500,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Plan the work' }]
    })
  })

  it('maps assistant text plus tool call and result blocks', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_2', time_created: 1_777_634_001_000, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_2',
          message_id: 'msg_2',
          time_created: 1_777_634_001_000,
          data: JSON.stringify({ type: 'text', text: 'Running it now' })
        },
        {
          id: 'part_3',
          message_id: 'msg_2',
          time_created: 1_777_634_001_100,
          data: toolData('completed')
        }
      ]
    )?.[0]
    expect(message?.role).toBe('assistant')
    expect(message?.blocks).toEqual([
      { type: 'text', text: 'Running it now' },
      { type: 'tool-call', name: 'bash', input: { command: 'ls' } },
      { type: 'tool-result', output: 'a.txt\nb.ts' }
    ])
  })

  it('marks a failed tool with an error result', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_2', time_created: 1_777_634_001_000, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_3',
          message_id: 'msg_2',
          time_created: 1_777_634_001_100,
          data: toolData('error')
        }
      ]
    )?.[0]
    expect(message?.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: { command: 'ls' } },
      { type: 'tool-result', output: 'command failed', isError: true }
    ])
  })

  it('shows a pending tool as a bare tool-call', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_2', time_created: 1_777_634_001_000, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_3',
          message_id: 'msg_2',
          time_created: 1_777_634_001_100,
          data: toolData('pending')
        }
      ]
    )?.[0]
    expect(message?.blocks).toEqual([{ type: 'tool-call', name: 'bash', input: { command: 'ls' } }])
  })

  it('maps reasoning-only messages to the reasoning role', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_3', time_created: 1_777_634_001_200, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_4',
          message_id: 'msg_3',
          time_created: 1_777_634_001_200,
          data: JSON.stringify({ type: 'reasoning', text: 'think step by step' })
        }
      ]
    )?.[0]
    expect(message).toMatchObject({ id: 'msg_3', role: 'reasoning' })
    expect(message?.blocks).toEqual([{ type: 'text', text: 'think step by step' }])
  })
  it('preserves reasoning before visible content for mixed parts', () => {
    const row = {
      id: 'msg_mixed',
      time_created: 1_777_634_001_250,
      data: JSON.stringify({ role: 'assistant' })
    }
    const parts = [
      {
        id: 'part_reasoning',
        message_id: row.id,
        time_created: row.time_created,
        data: JSON.stringify({ type: 'reasoning', text: 'considering the change' })
      },
      {
        id: 'part_text',
        message_id: row.id,
        time_created: 1_777_634_001_300,
        data: JSON.stringify({ type: 'text', text: 'implemented the change' })
      }
    ]
    const first = mapOpenCodeNativeChatMessages(row, parts)
    const second = mapOpenCodeNativeChatMessages(row, parts)
    expect(first).toMatchObject([
      {
        id: 'msg_mixed:reasoning',
        role: 'reasoning',
        timestamp: row.time_created,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'considering the change' }]
      },
      {
        id: 'msg_mixed',
        role: 'assistant',
        timestamp: row.time_created,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'implemented the change' }]
      }
    ])
    expect(second).toEqual(first)
  })

  it('surfaces patch activity as a patch tool-call', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_4', time_created: 1_777_634_001_300, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_5',
          message_id: 'msg_4',
          time_created: 1_777_634_001_300,
          data: JSON.stringify({
            type: 'patch',
            hash: 'a1b2',
            files: ['/work/src/a.ts', '/work/src/b.ts']
          })
        }
      ]
    )?.[0]
    expect(message?.blocks).toEqual([
      {
        type: 'tool-call',
        name: 'patch',
        input: { hash: 'a1b2', files: ['/work/src/a.ts', '/work/src/b.ts'] }
      }
    ])
  })

  it('ignores lifecycle noise parts (step-start, step-finish) when the message has real content', () => {
    const message = mapOpenCodeNativeChatMessages(
      { id: 'msg_5', time_created: 1_777_634_001_400, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_6',
          message_id: 'msg_5',
          time_created: 1_777_634_001_400,
          data: JSON.stringify({ type: 'step-start', snapshot: 'abc' })
        },
        {
          id: 'part_7',
          message_id: 'msg_5',
          time_created: 1_777_634_001_400,
          data: JSON.stringify({ type: 'text', text: 'final answer' })
        }
      ]
    )?.[0]
    expect(message?.blocks).toEqual([{ type: 'text', text: 'final answer' }])
  })

  it('tolerates malformed message and part JSON without throwing', () => {
    expect(
      mapOpenCodeNativeChatMessages(
        { id: 'msg_bad', time_created: 1_777_634_001_500, data: '{not json' },
        []
      )
    ).toBeNull()
    const valid = mapOpenCodeNativeChatMessages(
      { id: 'msg_ok', time_created: 1_777_634_001_600, data: JSON.stringify({ role: 'user' }) },
      [
        {
          id: 'part_bad',
          message_id: 'msg_ok',
          time_created: 1_777_634_001_600,
          data: '{{{broken'
        },
        {
          id: 'part_ok',
          message_id: 'msg_ok',
          time_created: 1_777_634_001_600,
          data: JSON.stringify({ type: 'text', text: 'still works' })
        }
      ]
    )?.[0]
    expect(valid?.blocks).toEqual([{ type: 'text', text: 'still works' }])
  })

  it('returns null for unknown roles and for no mapable content', () => {
    expect(
      mapOpenCodeNativeChatMessages(
        {
          id: 'msg_sys',
          time_created: 1_777_634_001_000,
          data: JSON.stringify({ role: 'system' })
        },
        []
      )
    ).toBeNull()
    expect(
      mapOpenCodeNativeChatMessages(
        {
          id: 'msg_empty',
          time_created: 1_777_634_001_000,
          data: JSON.stringify({ role: 'assistant' })
        },
        [
          {
            id: 'part_noise',
            message_id: 'msg_empty',
            time_created: 1_777_634_001_000,
            data: JSON.stringify({ type: 'step-start', snapshot: 'x' })
          }
        ]
      )
    ).toBeNull()
  })

  it('caps oversized text and tool output rather than shipping them whole', () => {
    const message = mapOpenCodeNativeChatMessages(
      {
        id: 'msg_big',
        time_created: 1_777_634_001_000,
        data: JSON.stringify({ role: 'assistant' })
      },
      [
        {
          id: 'part_big',
          message_id: 'msg_big',
          time_created: 1_777_634_001_000,
          data: JSON.stringify({ type: 'text', text: 'x'.repeat(70_000) })
        },
        {
          id: 'part_out',
          message_id: 'msg_big',
          time_created: 1_777_634_001_100,
          data: JSON.stringify({
            type: 'tool',
            tool: 'read',
            state: { status: 'completed', output: 'y'.repeat(200_000) }
          })
        }
      ]
    )?.[0]
    const textBlock = message?.blocks[0]
    expect(textBlock?.type === 'text' ? textBlock.text.length : 0).toBeLessThan(70_000)
    const resultBlock = message?.blocks[1]
    expect(resultBlock?.type === 'tool-result' ? resultBlock.output.length : 0).toBeLessThan(
      200_000
    )
  })

  it('produces a content signature that tracks mutable parts', () => {
    const base = mapOpenCodeNativeChatMessages(
      { id: 'msg_s', time_created: 1_777_634_001_000, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_s',
          message_id: 'msg_s',
          time_created: 1_777_634_001_000,
          data: JSON.stringify({ type: 'text', text: 'stream' })
        }
      ]
    )?.[0]
    const extended = mapOpenCodeNativeChatMessages(
      { id: 'msg_s', time_created: 1_777_634_001_000, data: JSON.stringify({ role: 'assistant' }) },
      [
        {
          id: 'part_s',
          message_id: 'msg_s',
          time_created: 1_777_634_001_000,
          data: JSON.stringify({ type: 'text', text: 'streaming more' })
        }
      ]
    )?.[0]
    expect(base && extended).toBeTruthy()
    if (!base || !extended) {
      return
    }
    expect(openCodeMessageSignature(base)).not.toBe(openCodeMessageSignature(extended))
  })
})

function buildOpenCodeFixture(): { db: DatabaseSync; path: string } {
  const { db, path } = createTempDb()
  applyOpenCodeSchema(db)
  insertSession(db, 'ses_1')
  insertMessage(db, {
    id: 'msg_1',
    sessionId: 'ses_1',
    role: 'user',
    timeCreated: 1_777_634_000_000
  })
  insertPart(db, {
    id: 'part_1',
    messageId: 'msg_1',
    sessionId: 'ses_1',
    timeCreated: 1_777_634_000_000,
    data: JSON.stringify({ type: 'text', text: 'hello' })
  })
  insertMessage(db, {
    id: 'msg_2',
    sessionId: 'ses_1',
    role: 'assistant',
    timeCreated: 1_777_634_001_000
  })
  insertPart(db, {
    id: 'part_2',
    messageId: 'msg_2',
    sessionId: 'ses_1',
    timeCreated: 1_777_634_001_000,
    data: JSON.stringify({ type: 'text', text: 'hi there' })
  })
  insertMessage(db, {
    id: 'msg_3',
    sessionId: 'ses_1',
    role: 'user',
    timeCreated: 1_777_634_002_000
  })
  insertPart(db, {
    id: 'part_3',
    messageId: 'msg_3',
    sessionId: 'ses_1',
    timeCreated: 1_777_634_002_000,
    data: JSON.stringify({ type: 'text', text: 'second ask' })
  })
  insertMessage(db, {
    id: 'msg_4',
    sessionId: 'ses_1',
    role: 'assistant',
    timeCreated: 1_777_634_003_000
  })
  insertPart(db, {
    id: 'part_4',
    messageId: 'msg_4',
    sessionId: 'ses_1',
    timeCreated: 1_777_634_003_000,
    data: JSON.stringify({ type: 'text', text: 'second answer' })
  })
  return { db, path }
}

describe('canReadOpenCodeChatSession', () => {
  it('guards against missing schema tables', () => {
    const { db, path } = createTempDb()
    db.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER)'
    )
    db.close()
    const unreadableDb = openSchemaCheckDatabase(path)
    expect(canReadOpenCodeChatSession(unreadableDb)).toBe(false)
    unreadableDb.close()

    const { db: completeDb, path: completePath } = createTempDb()
    applyOpenCodeSchema(completeDb)
    completeDb.close()
    const readableDb = openSchemaCheckDatabase(completePath)
    expect(canReadOpenCodeChatSession(readableDb)).toBe(true)
    readableDb.close()
    expect(path.endsWith('opencode.db')).toBe(true)
  })

  it('requires the columns used by the reader before issuing transcript queries', () => {
    const { db, path } = createTempDb()
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        message_id TEXT,
        time_created INTEGER,
        data TEXT
      );
    `)
    db.close()
    const unreadableDb = openSchemaCheckDatabase(path)
    expect(canReadOpenCodeChatSession(unreadableDb)).toBe(false)
    unreadableDb.close()
  })
})

describe('readOpenCodeNativeChatTranscriptTail', () => {
  it('reads the tail chronologically with stable ids and timestamps', async () => {
    const { db, path } = buildOpenCodeFixture()
    db.close()
    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 40
    })
    expect('error' in result).toBe(false)
    if ('error' in result) {
      return
    }
    expect(result.messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4'])
    expect(result.messages.map((m) => m.timestamp)).toEqual([
      1_777_634_000_000, 1_777_634_001_000, 1_777_634_002_000, 1_777_634_003_000
    ])
    expect(result.hasMore).toBe(false)
    expect(result.beforeOffset).toBe(0)
  })

  it('reads a consistent WAL snapshot while a writer transaction is open', async () => {
    const { db, path } = buildOpenCodeFixture()
    db.close()
    const writer = new DatabaseSync(path)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec('BEGIN IMMEDIATE')
    insertMessage(writer, {
      id: 'msg_uncommitted',
      sessionId: 'ses_1',
      role: 'assistant',
      timeCreated: 1_777_634_004_000
    })
    insertPart(writer, {
      id: 'part_uncommitted',
      messageId: 'msg_uncommitted',
      sessionId: 'ses_1',
      timeCreated: 1_777_634_004_000,
      data: JSON.stringify({ type: 'text', text: 'not committed yet' })
    })

    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 40
    })
    writer.exec('ROLLBACK')
    writer.close()
    if ('error' in result) {
      throw new Error(result.error)
    }
    expect(result.messages.map((message) => message.id)).toEqual([
      'msg_1',
      'msg_2',
      'msg_3',
      'msg_4'
    ])
  })

  it('pages older history with beforeOffset without overlap', async () => {
    const { db, path } = buildOpenCodeFixture()
    db.close()

    const first = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 2
    })
    if ('error' in first) {
      throw new Error(first.error)
    }
    expect(first.messages.map((m) => m.id)).toEqual(['msg_3', 'msg_4'])
    expect(first.hasMore).toBe(true)
    expect(first.beforeOffset).toBe(2)

    const older = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 2,
      beforeOffset: first.beforeOffset
    })
    if ('error' in older) {
      throw new Error(older.error)
    }
    expect(older.messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2'])
    expect(older.hasMore).toBe(false)
    expect(older.beforeOffset).toBe(0)
  })

  it('clamps pagination at the conversation start without repeating rows', async () => {
    const { db, path } = buildOpenCodeFixture()
    db.close()
    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 10,
      beforeOffset: 1
    })
    if ('error' in result) {
      throw new Error(result.error)
    }
    // boundary index 1 → only msg_1 is older.
    expect(result.messages.map((m) => m.id)).toEqual(['msg_1'])
    expect(result.hasMore).toBe(false)
    expect(result.beforeOffset).toBe(0)
  })

  it('returns an empty tail for a session with no mapable messages', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_empty')
    db.close()
    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_empty',
      limit: 40
    })
    expect(result).toEqual({ messages: [], hasMore: false, beforeOffset: 0 })
  })

  it('tolerates malformed rows in the middle of a session', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_mal')
    insertMessage(db, { id: 'msg_good1', sessionId: 'ses_mal', role: 'user', timeCreated: 1 })
    insertPart(db, {
      id: 'p_good1',
      messageId: 'msg_good1',
      sessionId: 'ses_mal',
      timeCreated: 1,
      data: JSON.stringify({ type: 'text', text: 'one' })
    })
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_bad', 'ses_mal', 2, 2, '{oops')`
    ).run()
    insertMessage(db, { id: 'msg_good2', sessionId: 'ses_mal', role: 'assistant', timeCreated: 3 })
    insertPart(db, {
      id: 'p_good2',
      messageId: 'msg_good2',
      sessionId: 'ses_mal',
      timeCreated: 3,
      data: '{broken too'
    })
    db.close()
    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_mal',
      limit: 40
    })
    if ('error' in result) {
      throw new Error(result.error)
    }
    expect(result.messages.map((m) => m.id)).toEqual(['msg_good1'])
  })

  it('pages across non-conversational rows without creating history gaps', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_mixed')
    insertMessage(db, { id: 'msg_old', sessionId: 'ses_mixed', role: 'user', timeCreated: 1 })
    insertPart(db, {
      id: 'part_old',
      messageId: 'msg_old',
      sessionId: 'ses_mixed',
      timeCreated: 1,
      data: JSON.stringify({ type: 'text', text: 'old' })
    })
    db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_noise', 'ses_mixed', 2, 2, '{"role":"system"}')`
    ).run()
    insertMessage(db, { id: 'msg_new', sessionId: 'ses_mixed', role: 'assistant', timeCreated: 3 })
    insertPart(db, {
      id: 'part_new',
      messageId: 'msg_new',
      sessionId: 'ses_mixed',
      timeCreated: 3,
      data: JSON.stringify({ type: 'text', text: 'new' })
    })
    db.close()

    const first = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_mixed',
      limit: 1
    })
    if ('error' in first) {
      throw new Error(first.error)
    }
    expect(first.messages.map((m) => m.id)).toEqual(['msg_new'])
    expect(first.hasMore).toBe(true)
    expect(first.beforeOffset).toBe(2)

    const older = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_mixed',
      limit: 1,
      beforeOffset: first.beforeOffset
    })
    if ('error' in older) {
      throw new Error(older.error)
    }
    expect(older.messages.map((m) => m.id)).toEqual(['msg_old'])
    expect(older.hasMore).toBe(false)
    expect(older.beforeOffset).toBe(0)
  })

  it('orders equal-time messages and excludes parts from another session', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_ordered')
    insertMessage(db, { id: 'msg_b', sessionId: 'ses_ordered', role: 'user', timeCreated: 5 })
    insertPart(db, {
      id: 'part_b',
      messageId: 'msg_b',
      sessionId: 'ses_ordered',
      timeCreated: 5,
      data: JSON.stringify({ type: 'text', text: 'B' })
    })
    insertMessage(db, { id: 'msg_a', sessionId: 'ses_ordered', role: 'assistant', timeCreated: 5 })
    insertPart(db, {
      id: 'part_a',
      messageId: 'msg_a',
      sessionId: 'ses_ordered',
      timeCreated: 5,
      data: JSON.stringify({ type: 'text', text: 'A' })
    })
    insertMessage(db, {
      id: 'msg_wrong_session',
      sessionId: 'ses_ordered',
      role: 'user',
      timeCreated: 6
    })
    insertPart(db, {
      id: 'part_wrong_session',
      messageId: 'msg_wrong_session',
      sessionId: 'ses_other',
      timeCreated: 6,
      data: JSON.stringify({ type: 'text', text: 'must not leak' })
    })
    db.close()

    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_ordered',
      limit: 40
    })
    if ('error' in result) {
      throw new Error(result.error)
    }
    expect(result.messages.map((message) => message.id)).toEqual(['msg_a', 'msg_b'])
  })

  it('deduplicates repeated message ids from a degraded schema', async () => {
    const { db, path } = createTempDb()
    db.exec(`
      CREATE TABLE session (id TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `)
    db.prepare('INSERT INTO session (id) VALUES (?)').run('ses_duplicate')
    const messageData = JSON.stringify({ role: 'assistant' })
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'duplicate',
      'ses_duplicate',
      1,
      messageData
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      'duplicate',
      'ses_duplicate',
      2,
      messageData
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
      'part_1',
      'duplicate',
      'ses_duplicate',
      1,
      JSON.stringify({ type: 'text', text: 'one' })
    )
    db.close()

    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_duplicate',
      limit: 40
    })
    if ('error' in result) {
      throw new Error(result.error)
    }
    expect(result.messages.map((message) => message.id)).toEqual(['duplicate'])
  })

  it('returns notFound for a missing session and a missing DB file', async () => {
    const { db, path } = buildOpenCodeFixture()
    db.close()
    const missingSession = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_nope',
      limit: 40
    })
    expect(missingSession).toMatchObject({ error: expect.any(String), notFound: true })

    const missingDb = await readOpenCodeNativeChatTranscriptTail({
      dbPath: join(tmpdir(), 'does-not-exist-opencode.db'),
      sessionId: 'ses_1',
      limit: 40
    })
    expect(missingDb).toEqual({ error: 'Transcript unavailable', notFound: true })
    expect(JSON.stringify(missingDb)).not.toContain('does-not-exist-opencode.db')
  })

  it('returns Transcript unavailable when the schema is unreadable', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE session (id TEXT)')
    db.close()
    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 40
    })
    expect(result).toEqual({ error: 'Transcript unavailable' })
  })

  it('normalizes a corrupt database into a safe transcript error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-corrupt-'))
    tempDirs.push(dir)
    const path = join(dir, 'opencode.db')
    writeFileSync(path, 'not a sqlite database')
    await expect(
      readOpenCodeNativeChatTranscriptTail({ dbPath: path, sessionId: 'ses_1', limit: 40 })
    ).resolves.toEqual({ error: 'Transcript unavailable' })
  })

  it('returns a retryable result when a writer holds an exclusive lock', async () => {
    const { db, path } = buildOpenCodeFixture()
    db.close()
    const writer = new DatabaseSync(path)
    writer.exec('BEGIN EXCLUSIVE')
    const result = await readOpenCodeNativeChatTranscriptTail({
      dbPath: path,
      sessionId: 'ses_1',
      limit: 40
    })
    writer.exec('ROLLBACK')
    writer.close()
    expect(result).toMatchObject({ retryable: true, error: 'SQLite database is locked' })
  })

  it('recognizes busy and locked SQLite errors as retryable', () => {
    expect(isRetryableOpenCodeSqliteError({ code: 'SQLITE_BUSY' })).toBe(true)
    expect(isRetryableOpenCodeSqliteError(new Error('database is locked'))).toBe(true)
    expect(isRetryableOpenCodeSqliteError(new Error('database disk image is malformed'))).toBe(
      false
    )
  })
})
