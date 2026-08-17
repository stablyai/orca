import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import {
  readOpenCodeNativeChatTranscriptFull,
  resolveOpenCodeTranscriptDbPath,
  subscribeOpenCodeNativeChatTranscript,
  type OpenCodeTranscriptDeps
} from './transcript-opencode'

// Live watcher verification against a real on-disk SQLite DB mutated by a
// second write connection between polls: proves append detection AND the
// in-place tool-result backfill (replace) detection the fingerprint folds
// MAX(part.time_updated) in for.

let tempDirs: string[] = []
let openDbs: Database.Database[] = []

afterEach(() => {
  for (const db of openDbs) {
    db.close()
  }
  openDbs = []
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function createDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-watch-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  openDbs.push(db)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
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
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    INSERT INTO session (id) VALUES ('ses-1');
  `)
  return { db, path }
}

function insertMessage(db: Database.Database, id: string, time: number, role: string): void {
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'ses-1', time, time, JSON.stringify({ role }))
}

function insertPart(
  db: Database.Database,
  id: string,
  messageId: string,
  time: number,
  data: unknown
): void {
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  ).run(id, messageId, 'ses-1', time, JSON.stringify(data))
}

function depsFor(path: string) {
  return {
    resolveDbPath: async () => path,
    readSignal: (dbPath: string, sessionId: string) =>
      Promise.resolve(readOpenCodeTranscriptSignal(dbPath, sessionId)),
    readPage: (args: Parameters<typeof readOpenCodeTranscriptPage>[0]) =>
      Promise.resolve(readOpenCodeTranscriptPage(args))
  }
}

describe('readOpenCodeNativeChatTranscriptFull', () => {
  const message = (id: string): NativeChatMessage => ({
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  })

  it('returns the whole session oldest-first across page boundaries', async () => {
    // Five messages served in windows of two: pages arrive newest-window-first
    // (each oldest-first); the full read must concatenate them globally
    // oldest-first like the JSONL full reader, not in page-fetch order.
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    const readPage: OpenCodeTranscriptDeps['readPage'] = async (args) => {
      const upper = args.beforeMessageRowId ?? 6
      const lower = Math.max(1, upper - 2)
      const slice = ids.slice(lower - 1, upper - 1)
      return {
        items: slice.map((id, index) => ({
          rowid: lower + index,
          fingerprint: id,
          message: message(id)
        })),
        hasMore: lower > 1,
        beforeMessageRowId: lower > 1 ? lower : null
      }
    }
    const result = await readOpenCodeNativeChatTranscriptFull('ses-1', {
      resolveDbPath: async () => '/fake/opencode.db',
      readPage
    })
    expect(result).toEqual({ messages: ids.map(message) })
  })

  it('reports notFound when the first page misses', async () => {
    const readPage: OpenCodeTranscriptDeps['readPage'] = async () => null
    const result = await readOpenCodeNativeChatTranscriptFull('missing', {
      resolveDbPath: async () => '/fake/opencode.db',
      readPage
    })
    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })
})

describe('resolveOpenCodeTranscriptDbPath', () => {
  function createDataHome(): string {
    const dataHome = mkdtempSync(join(tmpdir(), 'orca-opencode-discover-'))
    tempDirs.push(dataHome)
    return dataHome
  }

  it('prefers the canonical opencode.db over stale opencode-*.db siblings', async () => {
    const dataHome = createDataHome()
    const dir = join(dataHome, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode-backup.db'), '')
    writeFileSync(join(dir, 'opencode.db'), '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(join(dir, 'opencode.db'))
  })

  it('falls back to a sibling when no canonical DB exists', async () => {
    const dataHome = createDataHome()
    const dir = join(dataHome, 'opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode-backup.db'), '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(join(dir, 'opencode-backup.db'))
  })

  it('honors the OPENCODE_DB override and returns null with no DBs', async () => {
    const dataHome = createDataHome()
    const override = join(dataHome, 'custom.db')
    writeFileSync(override, '')
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    vi.stubEnv('OPENCODE_DB', override)
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(override)

    vi.stubEnv('OPENCODE_DB', '')
    await expect(resolveOpenCodeTranscriptDbPath()).resolves.toBe(null)
  })
})

describe('subscribeOpenCodeNativeChatTranscript (live)', () => {
  it('snapshots, appends new messages, and replaces on in-place part backfill', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'first prompt' })
    insertMessage(db, 'msg-2', 2_000, 'assistant')
    // A tool call that is still running — no output captured yet.
    insertPart(db, 'prt-2', 'msg-2', 2_000, {
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' } }
    })

    const frames: {
      kind: 'snapshot' | 'appended' | 'replaced'
      messages: NativeChatMessage[]
    }[] = []

    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        initialLimit: 10,
        resolvePollIntervalMs: 20,
        onInitialSnapshot: (messages) => frames.push({ kind: 'snapshot', messages }),
        onAppend: (messages) => frames.push({ kind: 'appended', messages }),
        onReplace: (messages) => frames.push({ kind: 'replaced', messages })
      },
      undefined,
      depsFor(path)
    )
    expect(subscription.watching).toBe(true)

    try {
      // 1) Initial snapshot carries both messages, tool call pending.
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'snapshot')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      const snapshot = frames.find((frame) => frame.kind === 'snapshot')!
      expect(snapshot.messages.map((message) => message.id)).toEqual(['msg-1', 'msg-2'])
      const pendingTool = snapshot.messages[1]!.blocks.at(-1)
      expect(pendingTool).toMatchObject({ type: 'tool-call', name: 'bash' })
      expect(snapshot.messages[1]!.blocks.some((block) => block.type === 'tool-result')).toBe(false)

      // 2) A brand-new message lands -> appended frame with exactly it.
      insertMessage(db, 'msg-3', 3_000, 'user')
      insertPart(db, 'prt-3', 'msg-3', 3_000, { type: 'text', text: 'follow-up' })
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'appended')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      const appended = frames.find((frame) => frame.kind === 'appended')!
      expect(appended.messages.map((message) => message.id)).toEqual(['msg-3'])

      // 3) In-place part backfill: the running tool on msg-2 completes —
      //    same part row rewritten (no new row), time_updated bumped. The
      //    fingerprint must see it and emit a replacement frame.
      db.prepare('UPDATE part SET time_updated = ?, data = ? WHERE id = ?').run(
        4_000,
        JSON.stringify({
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'ls' }, output: 'file list' }
        }),
        'prt-2'
      )
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'replaced')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      const replaced = frames.find((frame) => frame.kind === 'replaced')!
      const completed = replaced.messages
        .find((message) => message.id === 'msg-2')!
        .blocks.find((block) => block.type === 'tool-result')
      expect(completed).toMatchObject({ type: 'tool-result', output: 'file list' })
    } finally {
      subscription.unsubscribe()
    }

    // Unsubscribe stops the poll loop: no further frames after a settle beat.
    const framesAtTearDown = frames.length
    insertMessage(db, 'msg-4', 5_000, 'user')
    insertPart(db, 'prt-4', 'msg-4', 5_000, { type: 'text', text: 'after teardown' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(frames.length).toBe(framesAtTearDown)
  })

  it('emits at most one error snapshot during a persistent read failure', async () => {
    const { path } = createDb()
    let failures = 0
    const errorFrames: string[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        resolvePollIntervalMs: 20,
        onInitialSnapshot: (_messages, _hasMore, _beforeOffset, error) => {
          if (error) {
            errorFrames.push(error)
          }
        },
        onAppend: () => {}
      },
      undefined,
      {
        resolveDbPath: async () => path,
        readSignal: () => {
          failures++
          return Promise.reject(new Error(`boom ${failures}`))
        },
        readPage: (args) =>
          Promise.resolve(
            readOpenCodeTranscriptPage(args as Parameters<typeof readOpenCodeTranscriptPage>[0])
          )
      }
    )
    try {
      await vi.waitFor(
        () => {
          expect(errorFrames.length).toBeGreaterThanOrEqual(1)
        },
        { timeout: 3_000, interval: 20 }
      )
      // Let several more failing polls through — the latch must hold at one.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(errorFrames).toHaveLength(1)
      expect(failures).toBeGreaterThan(3)
    } finally {
      subscription.unsubscribe()
    }
  })
})
