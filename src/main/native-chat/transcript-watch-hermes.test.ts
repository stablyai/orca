import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { subscribeNativeChatTranscript } from './transcript-watch'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createHermesStateDb(): { db: DatabaseSync; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-hermes-watch-'))
  tempRoots.push(root)
  const path = join(root, 'state.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL,
      active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0
    )
  `)
  return { db, path }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('subscribeNativeChatTranscript Hermes state.db', () => {
  it('delivers only active rows and rows appended after subscription', async () => {
    const { db, path } = createHermesStateDb()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[] = []
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'session-1', 'user', 'before', 1_787_000_000)
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(2, 'session-1', 'assistant', 'rewound', 1_787_000_001, 0, 0)
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(3, 'session-1', 'assistant', 'compacted', 1_787_000_002, 0, 1)

    let subscription: Awaited<ReturnType<typeof subscribeNativeChatTranscript>> | undefined
    try {
      subscription = await subscribeNativeChatTranscript({
        agent: 'hermes',
        sessionId: 'session-1',
        filePath: path,
        initialLimit: 300,
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: (messages) => appends.push(...messages)
      })

      await waitFor(() => snapshots.length === 1)
      expect(snapshots[0]?.map((message) => message.blocks)).toEqual([
        [{ type: 'text', text: 'before' }]
      ])

      db.prepare(
        'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(4, 'session-1', 'assistant', 'after', 1_787_000_003)

      await waitFor(() =>
        appends.some(
          (message) => message.blocks[0]?.type === 'text' && message.blocks[0].text === 'after'
        )
      )
    } finally {
      subscription?.unsubscribe()
      db.close()
    }
  })

  it('does not lose a burst larger than the initial window', async () => {
    const { db, path } = createHermesStateDb()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[] = []
    const insert = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run(1, 'session-1', 'user', 'before-1', 1_787_000_000)
    insert.run(2, 'session-1', 'assistant', 'before-2', 1_787_000_001)

    let subscription: Awaited<ReturnType<typeof subscribeNativeChatTranscript>> | undefined
    try {
      subscription = await subscribeNativeChatTranscript({
        agent: 'hermes',
        sessionId: 'session-1',
        filePath: path,
        initialLimit: 2,
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: (messages) => appends.push(...messages)
      })
      await waitFor(() => snapshots.length === 1)

      insert.run(3, 'session-1', 'user', 'after-1', 1_787_000_002)
      insert.run(4, 'session-1', 'assistant', 'after-2', 1_787_000_003)
      insert.run(5, 'session-1', 'user', 'after-3', 1_787_000_004)

      await waitFor(() => appends.length === 3)
      expect(appends.map((message) => message.id)).toEqual(['3', '4', '5'])
    } finally {
      subscription?.unsubscribe()
      db.close()
    }
  })

  it('catches the first row appended to an initially empty database', async () => {
    const { db, path } = createHermesStateDb()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[] = []
    let subscription: Awaited<ReturnType<typeof subscribeNativeChatTranscript>> | undefined
    try {
      subscription = await subscribeNativeChatTranscript({
        agent: 'hermes',
        sessionId: 'session-1',
        filePath: path,
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: (messages) => appends.push(...messages)
      })
      await waitFor(() => snapshots.length === 1)
      expect(snapshots[0]).toEqual([])

      db.prepare(
        'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(1, 'session-1', 'user', 'first', 1_787_000_000)

      await waitFor(() => appends.length === 1)
      expect(appends[0]?.blocks).toEqual([{ type: 'text', text: 'first' }])
    } finally {
      subscription?.unsubscribe()
      db.close()
    }
  })

  it('keeps legacy databases without activity columns readable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-legacy-'))
    tempRoots.push(root)
    const path = join(root, 'state.db')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL
      )
    `)
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'session-1', 'user', 'legacy', 1_787_000_000)
    db.close()

    const snapshots: NativeChatMessage[][] = []
    let subscription: Awaited<ReturnType<typeof subscribeNativeChatTranscript>> | undefined
    try {
      subscription = await subscribeNativeChatTranscript({
        agent: 'hermes',
        sessionId: 'session-1',
        filePath: path,
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: () => {}
      })
      await waitFor(() => snapshots.length === 1)
      expect(snapshots[0]?.[0]?.blocks).toEqual([{ type: 'text', text: 'legacy' }])
    } finally {
      subscription?.unsubscribe()
    }
  })
})
