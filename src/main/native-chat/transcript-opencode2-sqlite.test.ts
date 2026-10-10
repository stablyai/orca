import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../shared/agent-session-host-status-rows'
import Database from '../sqlite/sync-database'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'

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
    INSERT INTO session_v2 VALUES ('session');`)
  let sequence = 0
  const insert = (id: string, type: string, data: unknown, time = 1) =>
    db
      .prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'session', type, ++sequence, JSON.stringify(data), time, time)
  return { db, path, insert }
}

describe('OpenCode 2 native transcript', () => {
  it('paginates real v2 user/assistant records past bookkeeping without losing messages', () => {
    const { path, insert } = fixture()
    insert('one', 'user', { text: 'first prompt' })
    insert('empty', 'idle', { outcome: 'succeeded' })
    insert('two', 'assistant', { content: [{ type: 'text', text: 'first reply' }] })
    insert('three', 'user', { text: 'second prompt' })
    insert('last-empty', 'idle', { outcome: 'succeeded' })
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 2 })
    expect(page?.items.map((item) => item.message.id)).toEqual(['opencode:two', 'opencode:three'])
    expect(page?.hasMore).toBe(true)
    const older = readOpenCodeTranscriptPage({
      dbPath: path,
      sessionId: 'session',
      limit: 2,
      beforeMessageRowId: page?.beforeMessageRowId ?? undefined
    })
    expect(older?.items.map((item) => item.message.id)).toEqual(['opencode:one'])
    expect(older?.hasMore).toBe(false)
  })

  it('preserves tool identity, inputs, outputs and errors across in-place updates', () => {
    const { db, path, insert } = fixture()
    const content = [
      {
        type: 'tool',
        id: 'call',
        name: 'bash',
        state: { status: 'running', input: { command: 'pwd' } }
      }
    ]
    insert('tool', 'assistant', { content })
    const before = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 2 })
    expect(before?.items[0]?.message.blocks).toEqual([
      {
        type: 'tool-call',
        callId: 'call',
        name: 'bash',
        state: 'running',
        input: { command: 'pwd' }
      }
    ])
    db.prepare('UPDATE session_message SET data = ?, time_updated = 2 WHERE id = ?').run(
      JSON.stringify({
        content: [
          {
            ...content[0],
            state: {
              status: 'error',
              input: { command: 'pwd' },
              error: { message: 'denied' },
              content: []
            }
          }
        ]
      }),
      'tool'
    )
    const after = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 2 })
    expect(after?.items[0]?.fingerprint).not.toBe(before?.items[0]?.fingerprint)
    expect(after?.items[0]?.message.blocks[0]).toMatchObject({ state: 'failed', callId: 'call' })
    expect(after?.items[0]?.message.blocks[1]).toMatchObject({ isError: true, callId: 'call' })
    expect(readOpenCodeTranscriptSignal(path, 'session')?.maxPartTimeUpdated).toBe(2)
  })

  it('surfaces provider errors and explicit interrupted boundaries', () => {
    const { path, insert } = fixture()
    insert('error', 'assistant', { error: { type: 'provider', message: 'Rate limit exceeded' } })
    insert('boundary', 'idle', { outcome: 'interrupted' })
    const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 2 })
    expect(page?.items.map((item) => item.message.blocks)).toEqual([
      [{ type: 'text', text: 'Rate limit exceeded' }],
      [{ type: 'text', text: 'Conversation interrupted' }]
    ])
  })

  it.each(['x', '😀'])(
    'omits oversized %s content with a stable cursor and time fingerprint',
    (character) => {
      const { db, path, insert } = fixture()
      insert('before', 'user', { text: 'before' })
      insert('large', 'user', {
        text: '',
        files: [{ mime: 'image/png', data: character.repeat(2 * 1024 * 1024) }]
      })
      insert('after', 'assistant', { text: 'after' })
      const args = { dbPath: path, sessionId: 'session', limit: 2 }
      const page = readOpenCodeTranscriptPage(args)
      expect(page?.items.map((item) => item.message.id)).toEqual([
        'opencode:large',
        'opencode:after'
      ])
      expect(page?.items[0]).toMatchObject({
        rowid: 2,
        message: {
          role: 'system',
          timestamp: 1,
          transcriptOffset: 2,
          blocks: [
            {
              type: 'text',
              text: AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'],
              presentation: 'history-item-too-large'
            }
          ]
        }
      })
      expect(readOpenCodeTranscriptPage(args)?.items[0]?.fingerprint).toBe(
        page?.items[0]?.fingerprint
      )
      db.prepare("UPDATE session_message SET time_updated = 2 WHERE id = 'large'").run()
      expect(readOpenCodeTranscriptPage(args)?.items[0]?.fingerprint).not.toBe(
        page?.items[0]?.fingerprint
      )
      expect(
        readOpenCodeTranscriptPage({
          ...args,
          beforeMessageRowId: page?.beforeMessageRowId ?? undefined
        })?.items.map((item) => item.message.id)
      ).toEqual(['opencode:before'])
    }
  )

  it('refuses excessive sparse scans instead of returning a partial transcript', () => {
    const { db, path, insert } = fixture()
    db.exec('BEGIN')
    for (let index = 0; index < 10001; index++) {
      insert(String(index), 'idle', {})
    }
    db.exec('COMMIT')
    expect(() =>
      readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 1 })
    ).toThrow('read limit')
  })

  it('keeps the aggregate page byte budget when individual rows fit', () => {
    const { db, path, insert } = fixture()
    db.exec('BEGIN')
    for (let index = 0; index < 18; index++) {
      insert(String(index), 'user', { text: 'x'.repeat(1024 * 1024) })
    }
    db.exec('COMMIT')
    expect(() =>
      readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 18 })
    ).toThrow('read limit')
  })

  it('reconciles live streaming updates and stops after unsubscribe', async () => {
    const { db, path, insert } = fixture()
    insert('reply', 'assistant', { content: [{ type: 'text', text: 'partial' }] })
    const snapshots: unknown[] = []
    const replacements: unknown[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'session',
        resolvePollIntervalMs: 5,
        onAppend: () => {},
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onReplace: (messages) => replacements.push(messages)
      },
      undefined,
      {
        resolveDbPath: async () => path,
        readSignal: async (dbPath, sessionId) => readOpenCodeTranscriptSignal(dbPath, sessionId),
        readPage: async (args) => readOpenCodeTranscriptPage(args)
      }
    )
    try {
      await expect.poll(() => snapshots.length).toBe(1)
      db.prepare('UPDATE session_message SET data = ?, time_updated = 2').run(
        JSON.stringify({ content: [{ type: 'text', text: 'complete' }] })
      )
      await expect.poll(() => replacements.length).toBe(1)
      expect(replacements[0]).toMatchObject([{ blocks: [{ text: 'complete' }] }])
      subscription.unsubscribe()
      db.prepare('UPDATE session_message SET time_updated = 3').run()
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(replacements).toHaveLength(1)
    } finally {
      subscription.unsubscribe()
    }
  })
})

it('preserves real v2 user image files with or without accompanying text', () => {
  const { path, insert } = fixture()
  const file = { data: 'YQ==', mime: 'image/png', source: { type: 'inline' }, name: 'tiny.png' }
  insert('text-image', 'user', { text: 'see this', files: [file] })
  insert('image-only', 'user', { text: '', files: [file] })
  const page = readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 10 })
  expect(page?.items.map((item) => item.message.blocks)).toEqual([
    [
      { type: 'text', text: 'see this' },
      { type: 'image-ref', url: `data:${file.mime};base64,${file.data}`, alt: 'tiny.png' }
    ],
    [{ type: 'image-ref', url: `data:${file.mime};base64,${file.data}`, alt: 'tiny.png' }]
  ])
})

it('prefers the migrated live v2 session over retained legacy tables for pages and signals', () => {
  const { db, path, insert } = fixture()
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
    INSERT INTO session VALUES ('session');
    INSERT INTO message VALUES ('old', 'session', 1, 1, '{"role":"user"}');
    INSERT INTO part VALUES ('part', 'old', 'session', 1, '{"type":"text","text":"frozen legacy"}');`)
  insert('imported', 'user', { text: 'migrated prompt' })
  insert('live', 'assistant', { content: [{ type: 'text', text: 'live reply' }] })
  expect(readOpenCodeTranscriptSignal(path, 'session')?.messageCount).toBe(2)
  expect(
    readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 10 })?.items.map(
      (item) => item.message.id
    )
  ).toEqual(['opencode:imported', 'opencode:live'])
})
