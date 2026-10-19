import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import {
  readOpenCodeNativeChatTranscriptFull,
  readOpenCodeNativeChatTranscriptTail
} from './transcript-opencode'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'
import { handleOpenCodeSqliteRequest } from '../ai-vault/session-scanner-opencode-sqlite-dispatch'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  vi.useRealTimers()
})

function fixture(sequenced = true) {
  const root = mkdtempSync(join(tmpdir(), 'orca-zcode-transcript-'))
  const dbPath = join(root, 'db.sqlite')
  const db = new Database(dbPath)
  cleanups.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER${sequenced ? ', sequence INTEGER' : ''});
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER${sequenced ? ', sequence INTEGER' : ''});
    INSERT INTO session VALUES ('session');
  `)
  const insert = (id: string, sequence: number | null, visibility?: string) => {
    const values = [
      id,
      'session',
      JSON.stringify({ role: 'user', semantics: { transcriptVisibility: visibility } }),
      1,
      1
    ]
    db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?${sequenced ? ', ?' : ''})`).run(
      ...values,
      ...(sequenced ? [sequence] : [])
    )
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, 1, 1${sequenced ? ', ?' : ''})`).run(
      id,
      id,
      'session',
      JSON.stringify({ type: 'text', text: id }),
      ...(sequenced ? [0] : [])
    )
  }
  const deps = {
    resolveDbPath: vi.fn(async () => dbPath),
    readSignal: async (path: string, sessionId: string, _signal?: AbortSignal, agent?: 'zcode') =>
      readOpenCodeTranscriptSignal(path, sessionId, agent),
    readPage: async (args: Parameters<typeof readOpenCodeTranscriptPage>[0]) =>
      readOpenCodeTranscriptPage(args)
  }
  return { db, dbPath, insert, deps }
}

it.each([true, false])(
  'filters hidden messages through full, tail and worker reads (sequence=%s)',
  async (sequenced) => {
    const f = fixture(sequenced)
    f.insert('legacy-visible', 0)
    f.insert('hidden', 1, 'hidden')
    f.insert('visible', 2, 'visible')
    expect(readOpenCodeTranscriptSignal(f.dbPath, 'session', 'zcode')).toMatchObject({
      messageCount: 2,
      partCount: 2
    })
    expect(readOpenCodeTranscriptSignal(f.dbPath, 'session')).toMatchObject({
      messageCount: 3,
      partCount: 3
    })
    const full = await readOpenCodeNativeChatTranscriptFull('session', f.deps, undefined, 'zcode')
    expect(full).toMatchObject({ messages: [{ id: 'legacy-visible' }, { id: 'visible' }] })
    const tail = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'session', limit: 1, agent: 'zcode' },
      f.deps
    )
    expect(tail).toMatchObject({ messages: [{ id: 'visible' }], hasMore: true })
    const response = await handleOpenCodeSqliteRequest({
      id: 1,
      kind: 'native-page',
      dbPath: f.dbPath,
      sessionId: 'session',
      limit: 10,
      agent: 'zcode'
    })
    expect(response).toMatchObject({
      ok: true,
      value: { items: [{ message: { id: 'legacy-visible' } }, { message: { id: 'visible' } }] }
    })
  }
)

it('paginates imported messages and parts by their recorded sequence', async () => {
  const f = fixture()
  f.insert('last', 2)
  f.insert('first', 0)
  f.insert('hidden', 1, 'hidden')
  f.insert('second', 1)
  f.insert('legacy-null', null)
  f.db.prepare('UPDATE part SET sequence = 1 WHERE id = ?').run('second')
  f.db
    .prepare('INSERT INTO part VALUES (?, ?, ?, ?, 1, 1, 0)')
    .run(
      'earlier-part',
      'second',
      'session',
      JSON.stringify({ type: 'text', text: 'earlier part' })
    )
  const full = await readOpenCodeNativeChatTranscriptFull('session', f.deps, undefined, 'zcode')
  expect(full).toMatchObject({
    messages: [
      { id: 'first' },
      { id: 'second', blocks: [{ text: 'earlier part' }, { text: 'second' }] },
      { id: 'last' },
      { id: 'legacy-null' }
    ]
  })
  const collected: string[] = []
  let cursor: number | undefined
  for (let index = 0; index < 5; index++) {
    const page = readOpenCodeTranscriptPage({
      dbPath: f.dbPath,
      sessionId: 'session',
      limit: 1,
      agent: 'zcode',
      beforeMessageRowId: cursor
    })
    collected.unshift(...(page?.items.map((item) => item.message.id) ?? []))
    if (!page?.hasMore) {
      break
    }
    cursor = page.beforeMessageRowId ?? undefined
  }
  expect(collected).toEqual(['first', 'second', 'last', 'legacy-null'])
})

it('reconciles visibility changes, ordered imports and deletions in a live chat', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.insert('last', 2)
  f.insert('first', 0)
  f.insert('hidden', 1, 'hidden')
  let displayed: NativeChatMessage[] = []
  const subscription = subscribeOpenCodeNativeChatTranscript(
    {
      agent: 'zcode',
      sessionId: 'session',
      resolvePollIntervalMs: 5,
      onInitialSnapshot: (messages) => {
        displayed = messages
      },
      onReplace: (messages) => {
        displayed = messages
      },
      onAppend: (messages) => {
        displayed.push(...messages)
      }
    },
    undefined,
    f.deps,
    'zcode'
  )
  cleanups.push(subscription.unsubscribe)
  await vi.advanceTimersByTimeAsync(0)
  expect(displayed.map((message) => message.id)).toEqual(['first', 'last'])
  f.db
    .prepare('UPDATE message SET data = ?, time_updated = 2 WHERE id = ?')
    .run(JSON.stringify({ role: 'user' }), 'hidden')
  await vi.advanceTimersByTimeAsync(5)
  expect(displayed.map((message) => message.id)).toEqual(['first', 'hidden', 'last'])
  f.insert('middle', 1)
  await vi.advanceTimersByTimeAsync(5)
  expect(displayed.map((message) => message.id)).toEqual(['first', 'hidden', 'middle', 'last'])
  f.db.prepare('DELETE FROM message WHERE id = ?').run('first')
  f.db.prepare('DELETE FROM part WHERE message_id = ?').run('first')
  await vi.advanceTimersByTimeAsync(5)
  expect(displayed.map((message) => message.id)).toEqual(['hidden', 'middle', 'last'])
})

it('keeps a paging cursor stable when earlier messages are removed or imported', () => {
  const f = fixture()
  f.insert('last', 3)
  f.insert('first', 0)
  f.insert('middle', 2)
  const newest = readOpenCodeTranscriptPage({
    dbPath: f.dbPath,
    sessionId: 'session',
    limit: 1,
    agent: 'zcode'
  })
  f.db.prepare('DELETE FROM message WHERE id = ?').run('first')
  f.db.prepare('DELETE FROM part WHERE message_id = ?').run('first')
  f.insert('imported', 1)
  const older = readOpenCodeTranscriptPage({
    dbPath: f.dbPath,
    sessionId: 'session',
    limit: 10,
    agent: 'zcode',
    beforeMessageRowId: newest?.beforeMessageRowId ?? undefined
  })
  expect(older?.items.map((item) => item.message.id)).toEqual(['imported', 'middle'])
})

it('observes a balanced visibility swap even when part counts and times stay unchanged', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.insert('first', 0)
  f.insert('hidden', 1, 'hidden')
  f.insert('last', 2)
  let displayed: NativeChatMessage[] = []
  const subscription = subscribeOpenCodeNativeChatTranscript(
    {
      agent: 'zcode',
      sessionId: 'session',
      resolvePollIntervalMs: 5,
      onInitialSnapshot: (messages) => {
        displayed = messages
      },
      onReplace: (messages) => {
        displayed = messages
      },
      onAppend: (messages) => {
        displayed.push(...messages)
      }
    },
    undefined,
    f.deps,
    'zcode'
  )
  cleanups.push(subscription.unsubscribe)
  await vi.advanceTimersByTimeAsync(0)
  f.db
    .prepare('UPDATE message SET data = ?, time_updated = 2 WHERE id = ?')
    .run(JSON.stringify({ role: 'user', semantics: { transcriptVisibility: 'hidden' } }), 'first')
  f.db
    .prepare('UPDATE message SET data = ?, time_updated = 2 WHERE id = ?')
    .run(JSON.stringify({ role: 'user' }), 'hidden')
  await vi.advanceTimersByTimeAsync(5)
  expect(displayed.map((message) => message.id)).toEqual(['hidden', 'last'])
})
