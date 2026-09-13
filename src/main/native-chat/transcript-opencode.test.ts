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
  readOpenCodeNativeChatTranscriptTail,
  resolveOpenCodeTranscriptDbPath,
  subscribeOpenCodeNativeChatTranscript,
  type OpenCodeTranscriptDeps
} from './transcript-opencode'
import { DESKTOP_READ_WINDOW } from './transcript-watch-contract'

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

  it('returns a retryable error when DB discovery throws', async () => {
    const result = await readOpenCodeNativeChatTranscriptFull('ses-1', {
      resolveDbPath: async () => {
        throw new Error('EACCES')
      },
      readPage: async () => null
    })
    expect(result).toEqual({ error: 'EACCES' })
  })
})

describe('readOpenCodeNativeChatTranscriptTail', () => {
  const message = (id: string): NativeChatMessage => ({
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript'
  })

  it('passes beforeOffset through, floors the limit, and returns the page shape', async () => {
    let seen: { limit: number; beforeMessageRowId?: number } | null = null
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10.9, beforeOffset: 42 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async (args) => {
          seen = args
          return {
            items: [{ rowid: 40, fingerprint: 'm1', message: message('m1') }],
            hasMore: true,
            beforeMessageRowId: 39
          }
        }
      }
    )
    expect(seen).toMatchObject({
      dbPath: '/fake/opencode.db',
      sessionId: 'ses-1',
      limit: 10,
      beforeMessageRowId: 42
    })
    expect(result).toEqual({ messages: [message('m1')], hasMore: true, beforeOffset: 39 })
  })

  it('defaults a non-positive limit to the desktop window and 0 beforeOffset', async () => {
    let seenLimit = 0
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 0 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async (args) => {
          seenLimit = args.limit
          return {
            items: [{ rowid: 7, fingerprint: 'm1', message: message('m1') }],
            hasMore: false,
            beforeMessageRowId: null
          }
        }
      }
    )
    expect(seenLimit).toBe(DESKTOP_READ_WINDOW)
    expect(result).toEqual({ messages: [message('m1')], hasMore: false, beforeOffset: 0 })
  })

  it('reports notFound when the page misses — the session row has not landed', async () => {
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async () => null
      }
    )
    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('reports notFound when no DB resolves', async () => {
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      { resolveDbPath: async () => null, readPage: async () => null }
    )
    expect(result).toEqual({ error: 'Transcript unavailable', notFound: true })
  })

  it('returns a retryable error without notFound when the page read throws', async () => {
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readPage: async () => {
          throw new Error('worker timeout')
        }
      }
    )
    expect(result).toEqual({ error: 'worker timeout' })
  })

  it('returns a retryable error when DB discovery throws', async () => {
    // Discovery scans the filesystem and can throw (EACCES/EIO) — the
    // value-error contract must not leak that as a rejection.
    const result = await readOpenCodeNativeChatTranscriptTail(
      { sessionId: 'ses-1', limit: 10 },
      {
        resolveDbPath: async () => {
          throw new Error('EACCES')
        },
        readPage: async () => null
      }
    )
    expect(result).toEqual({ error: 'EACCES' })
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

  it('delivers a real snapshot after transient read failures', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'first prompt' })

    let signalCalls = 0
    const snapshots: { messages: NativeChatMessage[]; error?: string }[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        resolvePollIntervalMs: 20,
        onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
          snapshots.push({ messages, error }),
        onAppend: () => {}
      },
      undefined,
      {
        resolveDbPath: async () => path,
        readSignal: (dbPath, sessionId) => {
          signalCalls++
          if (signalCalls <= 2) {
            return Promise.reject(new Error(`boom ${signalCalls}`))
          }
          return Promise.resolve(readOpenCodeTranscriptSignal(dbPath, sessionId))
        },
        readPage: (args) =>
          Promise.resolve(
            readOpenCodeTranscriptPage(args as Parameters<typeof readOpenCodeTranscriptPage>[0])
          )
      }
    )
    try {
      // One transient error frame first…
      await vi.waitFor(
        () => {
          expect(snapshots.some((snapshot) => snapshot.error)).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      // …then recovery: the real snapshot still arrives with the messages.
      await vi.waitFor(
        () => {
          expect(snapshots.some((snapshot) => snapshot.messages.length > 0)).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      const recovered = snapshots.find((snapshot) => snapshot.messages.length > 0)!
      expect(recovered.messages.map((message) => message.id)).toEqual(['msg-1'])
      expect(snapshots.filter((snapshot) => snapshot.error)).toHaveLength(1)
    } finally {
      subscription.unsubscribe()
    }
  })

  it('retries a vanished first page as a first snapshot instead of stalling', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'first prompt' })

    let pageReads = 0
    const snapshots: NativeChatMessage[][] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        resolvePollIntervalMs: 20,
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: () => {}
      },
      undefined,
      {
        resolveDbPath: async () => path,
        readSignal: (dbPath, sessionId) =>
          Promise.resolve(readOpenCodeTranscriptSignal(dbPath, sessionId)),
        // First page read misses — the next tick must retry as a first snapshot.
        readPage: (args) => {
          pageReads++
          if (pageReads === 1) {
            return Promise.resolve(null)
          }
          return Promise.resolve(
            readOpenCodeTranscriptPage(args as Parameters<typeof readOpenCodeTranscriptPage>[0])
          )
        }
      }
    )
    try {
      await vi.waitFor(
        () => {
          expect(snapshots.length).toBeGreaterThanOrEqual(1)
        },
        { timeout: 3_000, interval: 20 }
      )
      expect(snapshots[0]!.map((message) => message.id)).toEqual(['msg-1'])
    } finally {
      subscription.unsubscribe()
    }
  })

  it('replaces the window when a poll gap skips more rows than the diff window', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'seed' })

    const frames: {
      kind: 'snapshot' | 'appended' | 'replaced'
      messages: NativeChatMessage[]
    }[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        initialLimit: 250,
        resolvePollIntervalMs: 20,
        onInitialSnapshot: (messages) => frames.push({ kind: 'snapshot', messages }),
        onAppend: (messages) => frames.push({ kind: 'appended', messages }),
        onReplace: (messages) => frames.push({ kind: 'replaced', messages })
      },
      undefined,
      depsFor(path)
    )
    try {
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'snapshot')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )

      // Land >WATCH_DIFF_WINDOW rows in one gap — overflow must surface via replace.
      for (let n = 2; n <= 130; n++) {
        insertMessage(db, `msg-${n}`, 2_000 + n, 'user')
        insertPart(db, `prt-${n}`, `msg-${n}`, 2_000 + n, { type: 'text', text: `body ${n}` })
      }
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'replaced')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      const replaced = frames.find((frame) => frame.kind === 'replaced')!
      expect(replaced.messages.map((message) => message.id)).toContain('msg-2')
      expect(replaced.messages).toHaveLength(130)
    } finally {
      subscription.unsubscribe()
    }
  })

  it('retries a failed replacement read on the next poll', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'first prompt' })
    insertMessage(db, 'msg-2', 2_000, 'assistant')
    insertPart(db, 'prt-2', 'msg-2', 2_000, {
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'ls' } }
    })

    let windowReads = 0
    const frames: NativeChatMessage[][] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        initialLimit: 10,
        resolvePollIntervalMs: 20,
        onInitialSnapshot: (messages) => frames.push(messages),
        onAppend: () => {},
        onReplace: (messages) => frames.push(messages)
      },
      undefined,
      {
        resolveDbPath: async () => path,
        readSignal: (dbPath, sessionId) =>
          Promise.resolve(readOpenCodeTranscriptSignal(dbPath, sessionId)),
        readPage: (args) => {
          if (args.limit === 10) {
            windowReads++
            if (windowReads === 2) {
              return Promise.resolve(null)
            }
          }
          return Promise.resolve(
            readOpenCodeTranscriptPage(args as Parameters<typeof readOpenCodeTranscriptPage>[0])
          )
        }
      }
    )
    try {
      await vi.waitFor(
        () => {
          expect(frames.length).toBeGreaterThanOrEqual(1)
        },
        { timeout: 3_000, interval: 20 }
      )

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
          expect(frames.length).toBeGreaterThanOrEqual(2)
        },
        { timeout: 3_000, interval: 20 }
      )
      expect(windowReads).toBe(3)
      const retried = frames.at(-1)!
      const completedTool = retried
        .find((message) => message.id === 'msg-2')!
        .blocks.find((block) => block.type === 'tool-result')
      expect(completedTool).toMatchObject({ type: 'tool-result', output: 'file list' })
    } finally {
      subscription.unsubscribe()
    }
  })
})

describe('subscribeOpenCodeNativeChatTranscript (robustness)', () => {
  it('does not emit spurious replaces for rows outside a narrow snapshot window', async () => {
    const { db, path } = createDb()
    for (let n = 1; n <= 5; n++) {
      insertMessage(db, `msg-${n}`, n * 1_000, 'user')
      insertPart(db, `prt-${n}`, `msg-${n}`, n * 1_000, { type: 'text', text: `m${n}` })
    }
    let replaces = 0
    const appended: string[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        initialLimit: 2,
        resolvePollIntervalMs: 20,
        onAppend: (messages) => appended.push(...messages.map((message) => message.id)),
        onReplace: () => {
          replaces++
        }
      },
      undefined,
      depsFor(path)
    )
    try {
      // Move the signal with a genuine append: rows older than the snapshot
      // window were never fingerprinted, but nothing changed, so the tick
      // must append (a missing has() guard reports every such row as changed
      // and fires a spurious replace instead).
      await new Promise((resolve) => setTimeout(resolve, 100))
      insertMessage(db, 'msg-6', 6_000, 'user')
      insertPart(db, 'prt-6', 'msg-6', 6_000, { type: 'text', text: 'm6' })
      await vi.waitFor(
        () => {
          expect(appended).toContain('msg-6')
        },
        { timeout: 3_000, interval: 20 }
      )
      expect(replaces).toBe(0)
    } finally {
      subscription.unsubscribe()
    }
  })

  it('bridges a poll-gap burst larger than the snapshot window without skipping rows', async () => {
    const { db, path } = createDb()
    for (let n = 1; n <= 3; n++) {
      insertMessage(db, `seed-${n}`, n * 1_000, 'user')
      insertPart(db, `seed-prt-${n}`, `seed-${n}`, n * 1_000, { type: 'text', text: `s${n}` })
    }
    const frames: { kind: 'snapshot' | 'replaced'; messages: NativeChatMessage[] }[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        initialLimit: 10,
        resolvePollIntervalMs: 20,
        onAppend: () => {},
        onInitialSnapshot: (messages) => frames.push({ kind: 'snapshot', messages }),
        onReplace: (messages) => frames.push({ kind: 'replaced', messages })
      },
      undefined,
      depsFor(path)
    )
    try {
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'snapshot')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      for (let n = 0; n < 150; n++) {
        insertMessage(db, `burst-${n}`, 10_000 + n, 'user')
        insertPart(db, `burst-prt-${n}`, `burst-${n}`, 10_000 + n, {
          type: 'text',
          text: `b${n}`
        })
      }
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'replaced')).toBe(true)
        },
        { timeout: 5_000, interval: 20 }
      )
      const replaced = frames.findLast((frame) => frame.kind === 'replaced')!
      // The whole burst must survive: the oldest burst row proves no middle
      // rows were skipped when the window overflowed.
      expect(replaced.messages.map((message) => message.id)).toContain('burst-0')
    } finally {
      subscription.unsubscribe()
    }
  })

  it('holds the whole gap back when even the max window cannot overlap', async () => {
    // Synthetic pages: the real-DB burst test above covers genuine bridging;
    // this one pins the cap branch, whose widening ladder would dominate the
    // event loop with real 2400-row JSON reads every 20ms tick.
    const SEED_ROWS = 3
    let totalRows = SEED_ROWS
    let signalReads = 0
    const message = (rowid: number): NativeChatMessage => ({
      id: `m-${rowid}`,
      role: 'user',
      blocks: [{ type: 'text', text: `b${rowid}` }],
      timestamp: null,
      source: 'transcript'
    })
    const readWindow = async (args: { limit: number }) => {
      const oldest = Math.max(1, totalRows - args.limit + 1)
      const items: { rowid: number; fingerprint: string; message: NativeChatMessage }[] = []
      for (let rowid = oldest; rowid <= totalRows; rowid++) {
        items.push({ rowid, fingerprint: `fp-${rowid}`, message: message(rowid) })
      }
      return {
        items,
        hasMore: oldest > 1,
        beforeMessageRowId: oldest > 1 ? oldest - 1 : null
      }
    }
    const frames: { kind: 'snapshot' | 'appended' | 'replaced'; messages: NativeChatMessage[] }[] =
      []
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
      {
        resolveDbPath: async () => '/fake/opencode.db',
        readSignal: async () => {
          signalReads++
          return {
            messageCount: totalRows,
            partCount: totalRows,
            maxMessageRowId: totalRows,
            maxPartTimeUpdated: totalRows * 1_000
          }
        },
        readPage: (args) => readWindow(args as { limit: number })
      }
    )
    try {
      await vi.waitFor(
        () => {
          expect(frames.some((frame) => frame.kind === 'snapshot')).toBe(true)
        },
        { timeout: 3_000, interval: 20 }
      )
      const signalReadsAtGap = signalReads

      // A gap beyond WATCH_REPLACE_MAX_WINDOW (2400): even the widest window
      // cannot reach the emitted frontier (rowid 3), so the tick must hold
      // everything back — no truncated replace that drops rows.
      totalRows = SEED_ROWS + 2_500
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(frames.filter((frame) => frame.kind !== 'snapshot')).toHaveLength(0)
      // Holding back, not dead: the signal keeps being polled for a retry.
      expect(signalReads).toBeGreaterThan(signalReadsAtGap + 2)
    } finally {
      subscription.unsubscribe()
    }
  })

  it('keeps polling when a subscriber callback throws', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'first' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const appended: string[] = []
    let calls = 0
    let snapshots = 0
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        initialLimit: 10,
        resolvePollIntervalMs: 20,
        onInitialSnapshot: () => {
          snapshots++
        },
        onAppend: (messages) => {
          calls++
          if (calls === 1) {
            throw new Error('renderer bug')
          }
          appended.push(...messages.map((message) => message.id))
        }
      },
      undefined,
      depsFor(path)
    )
    try {
      // Settle the snapshot first: inserting before it lands would fold the
      // row into the snapshot instead of exercising the append path.
      await vi.waitFor(
        () => {
          expect(snapshots).toBeGreaterThanOrEqual(1)
        },
        { timeout: 3_000, interval: 20 }
      )
      insertMessage(db, 'msg-2', 2_000, 'user')
      insertPart(db, 'prt-2', 'msg-2', 2_000, { type: 'text', text: 'second' })
      await vi.waitFor(
        () => {
          expect(warn).toHaveBeenCalled()
        },
        { timeout: 3_000, interval: 20 }
      )
      // The loop survived the throwing subscriber: later appends still arrive.
      insertMessage(db, 'msg-3', 3_000, 'user')
      insertPart(db, 'prt-3', 'msg-3', 3_000, { type: 'text', text: 'third' })
      await vi.waitFor(
        () => {
          expect(appended).toContain('msg-3')
        },
        { timeout: 3_000, interval: 20 }
      )
    } finally {
      subscription.unsubscribe()
    }
  })

  it('performs no reads when subscribing with an already-aborted signal', async () => {
    const { path } = createDb()
    let resolves = 0
    const controller = new AbortController()
    controller.abort()
    expect(() =>
      subscribeOpenCodeNativeChatTranscript(
        { agent: 'opencode', sessionId: 'ses-1', onAppend: () => {} },
        controller.signal,
        {
          ...depsFor(path),
          resolveDbPath: async () => {
            resolves++
            return path
          }
        }
      )
    ).toThrow()
    expect(resolves).toBe(0)
  })

  it('terminates the full read when a page repeats its cursor with hasMore', async () => {
    const { path } = createDb()
    const result = await readOpenCodeNativeChatTranscriptFull('ses-1', {
      resolveDbPath: async () => path,
      readPage: () => Promise.resolve({ items: [], hasMore: true, beforeMessageRowId: 5 })
    })
    expect(result).toEqual({ messages: [] })
  })
})

describe('subscribeOpenCodeNativeChatTranscript (pending settle)', () => {
  it('settles an unlanded session once instead of spinning', async () => {
    const { path } = createDb()
    let pendingCalls = 0
    const snapshots: NativeChatMessage[][] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        resolvePollIntervalMs: 20,
        onTranscriptPending: () => {
          pendingCalls++
        },
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: () => {}
      },
      undefined,
      {
        // The hook fired before the session row landed — signal stays null.
        resolveDbPath: async () => path,
        readSignal: async () => null,
        readPage: async () => null
      }
    )
    try {
      await vi.waitFor(
        () => {
          expect(pendingCalls).toBe(1)
        },
        { timeout: 3_000, interval: 50 }
      )
      // Fires at most once, and never as a snapshot.
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(pendingCalls).toBe(1)
      expect(snapshots).toHaveLength(0)
    } finally {
      subscription.unsubscribe()
    }
  })

  it('cancels the settle once a real snapshot lands', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'msg-1', 1_000, 'user')
    insertPart(db, 'prt-1', 'msg-1', 1_000, { type: 'text', text: 'first' })
    let pendingCalls = 0
    const snapshots: NativeChatMessage[][] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        resolvePollIntervalMs: 20,
        onTranscriptPending: () => {
          pendingCalls++
        },
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: () => {}
      },
      undefined,
      depsFor(path)
    )
    try {
      await vi.waitFor(
        () => {
          expect(snapshots.length).toBeGreaterThanOrEqual(1)
        },
        { timeout: 3_000, interval: 20 }
      )
      // Past the settle deadline with a frame delivered: pending stays silent.
      await new Promise((resolve) => setTimeout(resolve, 1_700))
      expect(pendingCalls).toBe(0)
    } finally {
      subscription.unsubscribe()
    }
  })
})
