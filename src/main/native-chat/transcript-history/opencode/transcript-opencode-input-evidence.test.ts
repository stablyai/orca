import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'
import { handleOpenCodeSqliteRequest } from '../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-dispatch'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  prunePendingSends,
  type NativeChatPendingSend
} from '../../../../shared/native-chat/transcript/native-chat-pending-sends'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import {
  encodeOpenCodeSqliteFrame,
  OPENCODE_SQLITE_RESPONSE_MAX_BYTES
} from '../../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-process-framing'
import Database from '../../../sqlite/sync-database'
import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import { readOpenCodeTranscriptPage } from './transcript-opencode-sqlite-query'

const fixtures: { db: Database.Database; root: string }[] = []
afterEach(() => {
  vi.restoreAllMocks()
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
  return { path, insert, db }
}

it('does not certify caption-only delivery after v2 discards an unknown attachment or source part', () => {
  const { path, insert } = fixture()
  insert('complete', 'user', { text: 'caption' })
  insert('unknown-file', 'user', { text: 'caption', files: [{ name: 'unknown' }] })
  insert('unknown-part', 'user', { content: [{ type: 'text', text: 'caption' }, null] })
  const page = readOpenCodeTranscriptPage({
    dbPath: path,
    sessionId: 'session',
    limit: 10,
    inputEvidence: true
  })!
  expect(page.items.map(({ message }) => [message.id, !!message.inputContent])).toEqual([
    ['opencode:complete', true],
    ['opencode:unknown-file', false],
    ['opencode:unknown-part', false]
  ])
})

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

it.each(['v1', 'v2'] as const)(
  'reconciles genuine native OpenCode %s SQLite user input',
  (version) => {
    const file =
      version === 'v1'
        ? 'opencode-v1-user-opencode1.19.5-g31595.json'
        : 'opencode-v2-user-opencode2.0.14-pr30580.json'
    const recorded: {
      message: Record<string, string | number>
      parts: Record<string, string | number>[]
      row: Record<string, string | number>
    } = JSON.parse(readFileSync(new URL(`../../__fixtures__/${file}`, import.meta.url), 'utf8'))
    const root = mkdtempSync(join(tmpdir(), 'orca-recorded-opencode-'))
    const path = join(root, 'opencode.db')
    const db = new Database(path)
    fixtures.push({ db, root })
    const row = version === 'v1' ? recorded.message : recorded.row
    const sessionId = String(row.session_id)
    if (version === 'v1') {
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
      db.prepare('INSERT INTO session VALUES (?)').run(sessionId)
      db.prepare(
        'INSERT INTO message (rowid, id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(row._rowid, row.id, row.session_id, row.time_created, row.time_updated, row.data)
      for (const part of recorded.parts) {
        db.prepare(
          'INSERT INTO part (rowid, id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          part._rowid,
          part.id,
          part.message_id,
          part.session_id,
          part.time_created,
          part.time_updated,
          part.data
        )
      }
    } else {
      db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);`)
      db.prepare('INSERT INTO session_v2 VALUES (?)').run(sessionId)
      db.prepare(
        'INSERT INTO session_message (rowid, id, session_id, type, seq, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        row._rowid,
        row.id,
        row.session_id,
        row.type,
        row.seq,
        row.data,
        row.time_created,
        row.time_updated
      )
    }
    const messages = readOpenCodeTranscriptPage({
      dbPath: path,
      sessionId,
      limit: 10,
      inputEvidence: true
    })!.items.map(({ message }) => message)
    expect(messages).toHaveLength(1)
    const text =
      version === 'v1'
        ? '"Read planner.py in this owned disposable project using a real read tool, then run a read-only Python probe of schedule for an oversized high-priority task and a smaller ready task. Explain the actual observed result briefly. Do not edit files, read outside this project, inspect config/environment/login/secrets, start other agents or services, use Computer Use or OS input, kill by pattern, add model restrictions, or weaken models."'
        : 'Read README.md in this workspace and report its sentence. Then explain in two sentences why sea water is salty.'
    const pending: NativeChatPendingSend = { id: 'send', sourceAgent: 'opencode', text, sentAt: 1 }
    const answer = {
      ...messages[0],
      id: 'answer',
      role: 'assistant' as const,
      inputContent: undefined
    }
    expect(prunePendingSends([pending], [...messages, answer])).toEqual([])
    const different = { ...pending, text: `${text} extra` }
    expect(prunePendingSends([different], [...messages, answer])).toEqual([different])
  }
)

it.each([
  { version: 'v1', size: 10 },
  { version: 'v1', size: 100 },
  { version: 'v2', size: 10 },
  { version: 'v2', size: 100 }
])(
  'omits $version OpenCode evidence before page sizing and transport for $size rows',
  async ({ version, size }) => {
    const { path, insert, db } = fixture()
    if (version === 'v1') {
      db.exec(`DROP TABLE session_v2; DROP TABLE session_message;
      CREATE TABLE session (id TEXT PRIMARY KEY);
      INSERT INTO session VALUES ('session');
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
    }
    for (let index = 0; index < size; index++) {
      if (version === 'v2') {
        insert(`u${index}`, 'user', { text: `exact input ${index}` })
      } else {
        db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
          `u${index}`,
          'session',
          1,
          1,
          '{"role":"user"}'
        )
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
          `p${index}`,
          `u${index}`,
          'session',
          1,
          1,
          JSON.stringify({ type: 'text', text: `exact input ${index}` })
        )
      }
    }
    const originalHash = crypto.createHash
    const updates: unknown[] = []
    const hash = vi.spyOn(crypto, 'createHash')
    hash.mockImplementation((...args) => {
      const digest = originalHash(...args)
      const update = digest.update.bind(digest)
      digest.update = (data: crypto.BinaryLike, inputEncoding?: crypto.Encoding) => {
        updates.push(data)
        return typeof data === 'string' && inputEncoding
          ? update(data, inputEncoding)
          : update(data)
      }
      return digest
    })
    const request = {
      id: 1,
      kind: 'native-page' as const,
      dbPath: path,
      sessionId: 'session',
      limit: size
    }
    const mobile = await handleOpenCodeSqliteRequest(request)
    const wire = encodeOpenCodeSqliteFrame(mobile, OPENCODE_SQLITE_RESPONSE_MAX_BYTES)
    expect(wire).not.toContain('inputContent')
    structuredClone(mobile)
    expect(
      updates.filter((text) => typeof text === 'string' && text.startsWith('exact input '))
    ).toHaveLength(0)
    const full = await readOpenCodeNativeChatTranscriptFull('session', {
      resolveDbPath: async () => path,
      readPage: async (args) => readOpenCodeTranscriptPage(args)
    })
    expect('messages' in full && full.messages.length).toBe(size)
    expect(
      updates.filter((text) => typeof text === 'string' && text.startsWith('exact input '))
    ).toHaveLength(0)
    updates.length = 0
    const desktop = await handleOpenCodeSqliteRequest({ ...request, inputEvidence: true })
    const desktopWire = encodeOpenCodeSqliteFrame(desktop, OPENCODE_SQLITE_RESPONSE_MAX_BYTES)
    structuredClone(desktop)
    expect(desktopWire).toContain('inputContent')
    expect(
      updates.filter((text) => typeof text === 'string' && text.startsWith('exact input '))
    ).toHaveLength(size)
  }
)

it.each([true, false])(
  'carries evidence demand through the existing bridged subscription, enabled: %s',
  async (inputEvidence) => {
    vi.useFakeTimers()
    const item = (rowid: number) => ({
      rowid,
      fingerprint: `${rowid}`,
      message: {
        id: `u${rowid}`,
        role: 'user' as const,
        source: 'transcript' as const,
        timestamp: null,
        blocks: []
      }
    })
    let revision = 1
    const reads: { limit: number; inputEvidence?: boolean }[] = []
    const snapshots: string[][] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'session',
        inputEvidence,
        initialLimit: 1,
        resolvePollIntervalMs: 10,
        onInitialSnapshot: (messages) => snapshots.push(messages.map((message) => message.id)),
        onReplace: (messages) => snapshots.push(messages.map((message) => message.id)),
        onAppend: () => {}
      },
      undefined,
      {
        resolveDbPath: async () => '/owned-test.db',
        readSignal: async () => ({
          messageCount: revision,
          partCount: revision,
          maxMessageRowId: revision,
          maxPartTimeUpdated: revision
        }),
        readPage: async (request) => {
          reads.push(request)
          return revision === 1
            ? { items: [item(1)], hasMore: false, beforeMessageRowId: 1 }
            : request.limit < 4
              ? { items: [item(3)], hasMore: true, beforeMessageRowId: 3 }
              : { items: [item(1), item(3)], hasMore: false, beforeMessageRowId: 1 }
        }
      }
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      revision = 2
      await vi.advanceTimersByTimeAsync(10)
      expect(snapshots).toEqual([['u1'], ['u1', 'u3']])
      expect(reads.some((request) => request.limit === 2)).toBe(true)
      expect(reads.every((request) => request.inputEvidence === inputEvidence)).toBe(true)
      subscription.unsubscribe()
      const completed = reads.length
      await vi.advanceTimersByTimeAsync(100)
      expect(reads).toHaveLength(completed)
    } finally {
      subscription.unsubscribe()
      vi.useRealTimers()
    }
  }
)
