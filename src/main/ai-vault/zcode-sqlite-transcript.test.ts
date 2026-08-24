import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { readZcodeSqliteTranscript, resolveZcodeSqliteDbPath } from './zcode-sqlite-transcript'

describe('ZCode SQLite worker transcripts', () => {
  let directory: string
  let dbPath: string
  let db: SyncDatabase

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-zcode-transcript-'))
    dbPath = join(directory, 'db.sqlite')
    db = new SyncDatabase(dbPath)
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `)
  })

  afterEach(async () => {
    db.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('preserves explicit SQLite database paths', () => {
    expect(resolveZcodeSqliteDbPath('/profiles/work/db.sqlite')).toBe('/profiles/work/db.sqlite')
    expect(resolveZcodeSqliteDbPath('/profiles/work/zcode.db')).toBe('/profiles/work/zcode.db')
  })

  it('tails visible messages and continues with the SQLite row cursor', () => {
    insert('m1', 'user', 'p1', { type: 'text', text: 'first' }, 1)
    insert('m2', 'assistant', 'p2', { type: 'reasoning', text: 'considering' }, 2)
    insert('m3', 'assistant', 'p3', { type: 'text', text: 'answer' }, 3)

    const initial = readZcodeSqliteTranscript({
      dbPath,
      sessionId: 'session-1',
      limit: 2
    })
    expect(initial).toMatchObject({
      messages: [
        { role: 'reasoning', blocks: [{ type: 'text', text: 'considering' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'answer' }] }
      ],
      limited: true
    })

    insert(
      'm4',
      'assistant',
      'p4',
      {
        type: 'tool',
        tool: 'Bash',
        state: { status: 'completed', input: { command: 'go test ./...' }, output: 'ok' }
      },
      4
    )
    const continued = readZcodeSqliteTranscript({
      dbPath,
      sessionId: 'session-1',
      offset: initial.nextOffset,
      limit: 2
    })
    expect(continued).toMatchObject({
      messages: [
        {
          role: 'tool',
          blocks: [
            { type: 'tool-call', name: 'Bash', input: { command: 'go test ./...' } },
            { type: 'tool-result', output: 'ok' }
          ]
        }
      ],
      limited: false
    })
  })

  it('excludes model-only ZCode messages', () => {
    insert('hidden', 'user', 'hidden-part', { type: 'text', text: 'internal reminder' }, 1, true)
    insert('visible', 'assistant', 'visible-part', { type: 'text', text: 'public result' }, 2)

    expect(
      readZcodeSqliteTranscript({ dbPath, sessionId: 'session-1', limit: 10 }).messages
    ).toEqual([
      expect.objectContaining({
        id: 'zcode:visible-part',
        blocks: [{ type: 'text', text: 'public result' }]
      })
    ])
  })

  it('pages backward without repeating the boundary row', () => {
    insert('m1', 'assistant', 'p1', { type: 'text', text: 'one' }, 1)
    insert('m2', 'assistant', 'p2', { type: 'text', text: 'two' }, 2)
    insert('m3', 'assistant', 'p3', { type: 'text', text: 'three' }, 3)

    const latest = readZcodeSqliteTranscript({ dbPath, sessionId: 'session-1', limit: 2 })
    const older = readZcodeSqliteTranscript({
      dbPath,
      sessionId: 'session-1',
      beforeOffset: latest.beforeOffset,
      limit: 2
    })

    expect(latest.messages.map((message) => message.id)).toEqual(['zcode:p2', 'zcode:p3'])
    expect(older.messages.map((message) => message.id)).toEqual(['zcode:p1'])
  })

  function insert(
    messageId: string,
    role: string,
    partId: string,
    part: unknown,
    timestamp: number,
    hidden = false
  ): void {
    db.prepare('INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
      messageId,
      'session-1',
      timestamp,
      JSON.stringify({
        role,
        anchor: { turnId: `turn-${messageId}` },
        semantics: { transcriptVisibility: hidden ? 'hidden' : 'visible' }
      })
    )
    db.prepare(
      'INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)'
    ).run(partId, messageId, 'session-1', timestamp, JSON.stringify(part))
  }
})
