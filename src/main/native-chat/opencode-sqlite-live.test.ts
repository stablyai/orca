import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenCodeNativeChatState,
  reconcileOpenCodeNativeChat,
  subscribeOpenCodeNativeChatTranscript
} from './opencode-sqlite-live'
import { openCodeMessageSignature } from './opencode-sqlite-transcript'
import { readOpenCodeNativeChatTranscript } from './opencode-sqlite-read'
import type { NativeChatMessage } from '../../shared/native-chat-types'

let tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(): { db: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-native-chat-live-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new DatabaseSync(path), path }
}

function applyOpenCodeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
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
    `INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
     VALUES (?, 'proj-1', '/work', 'S', ?, ?)`
  ).run(id, timeCreated, timeCreated)
}

function upsertMessage(
  db: DatabaseSync,
  args: { id: string; sessionId: string; role: 'user' | 'assistant'; timeCreated: number }
): void {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    args.id,
    args.sessionId,
    args.timeCreated,
    args.timeCreated,
    JSON.stringify({ role: args.role })
  )
}

function upsertPart(
  db: DatabaseSync,
  args: { id: string; messageId: string; sessionId: string; timeCreated: number; data: string }
): void {
  // Why: mirrors OpenCode mutating a part's data in place during streaming.
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, time_updated = excluded.time_updated`
  ).run(args.id, args.messageId, args.sessionId, args.timeCreated, Date.now(), args.data)
}

function textPart(text: string): string {
  return JSON.stringify({ type: 'text', text })
}

describe('reconcileOpenCodeNativeChat', () => {
  it('emits an initial tail snapshot then only delta appends', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_1')
    upsertMessage(db, { id: 'm1', sessionId: 'ses_1', role: 'user', timeCreated: 1 })
    upsertPart(db, {
      id: 'p1',
      messageId: 'm1',
      sessionId: 'ses_1',
      timeCreated: 1,
      data: textPart('ask')
    })
    upsertMessage(db, { id: 'm2', sessionId: 'ses_1', role: 'assistant', timeCreated: 2 })
    upsertPart(db, {
      id: 'p2',
      messageId: 'm2',
      sessionId: 'ses_1',
      timeCreated: 2,
      data: textPart('going')
    })
    db.close()

    const state = createOpenCodeNativeChatState()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[][] = []
    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_1',
      windowLimit: 40,
      state,
      onInitialSnapshot: (messages) => snapshots.push(messages),
      onAppend: (messages) => appends.push(messages)
    })
    expect(snapshots).toEqual([
      [expect.objectContaining({ id: 'm1' }), expect.objectContaining({ id: 'm2' })]
    ])
    expect(appends).toEqual([])

    // No change → nothing re-emitted.
    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_1',
      windowLimit: 40,
      state,
      onInitialSnapshot: (messages) => snapshots.push(messages),
      onAppend: (messages) => appends.push(messages)
    })
    expect(appends).toEqual([])
  })
  it('keeps a valid empty session live until its first message arrives', async () => {
    vi.useFakeTimers()
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_empty')
    db.close()

    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[][] = []
    const subscription = subscribeOpenCodeNativeChatTranscript({
      dbPath: path,
      sessionId: 'ses_empty',
      reconciliationIntervalMs: 1_000,
      onInitialSnapshot: (messages) => snapshots.push(messages),
      onAppend: (messages) => appends.push(messages)
    })
    await vi.advanceTimersByTimeAsync(40)
    expect(snapshots).toEqual([[]])

    const db2 = new DatabaseSync(path)
    upsertMessage(db2, { id: 'm1', sessionId: 'ses_empty', role: 'user', timeCreated: 1 })
    upsertPart(db2, {
      id: 'p1',
      messageId: 'm1',
      sessionId: 'ses_empty',
      timeCreated: 1,
      data: textPart('first message')
    })
    db2.close()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(appends).toEqual([[expect.objectContaining({ id: 'm1', role: 'user' })]])
    subscription.unsubscribe()
  })

  it('re-emits a mutated streaming part under the SAME stable id', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_1')
    upsertMessage(db, { id: 'm1', sessionId: 'ses_1', role: 'user', timeCreated: 1 })
    upsertPart(db, {
      id: 'p1',
      messageId: 'm1',
      sessionId: 'ses_1',
      timeCreated: 1,
      data: textPart('ask')
    })
    upsertMessage(db, { id: 'm2', sessionId: 'ses_1', role: 'assistant', timeCreated: 2 })
    upsertPart(db, {
      id: 'p2',
      messageId: 'm2',
      sessionId: 'ses_1',
      timeCreated: 2,
      data: textPart('answ')
    })
    db.close()

    const state = createOpenCodeNativeChatState()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[][] = []
    const emit = {
      onInitialSnapshot: (messages: NativeChatMessage[]) => snapshots.push(messages),
      onAppend: (messages: NativeChatMessage[]) => appends.push(messages)
    }
    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_1',
      windowLimit: 40,
      state,
      ...emit
    })

    // OpenCode rewrites the assistant text part in place (same part id).
    const db2 = new DatabaseSync(path)
    upsertPart(db2, {
      id: 'p2',
      messageId: 'm2',
      sessionId: 'ses_1',
      timeCreated: 2,
      data: textPart('answering now')
    })
    db2.close()

    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_1',
      windowLimit: 40,
      state,
      ...emit
    })
    expect(appends).toHaveLength(1)
    expect(appends[0]).toHaveLength(1)
    expect(appends[0][0]).toMatchObject({ id: 'm2', role: 'assistant' })
    expect(openCodeMessageSignature(appends[0][0])).not.toBe(
      openCodeMessageSignature(snapshots[0][1])
    )
  })

  it('appends only new messages as they arrive and never re-emits paged history', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_1')
    upsertMessage(db, { id: 'm1', sessionId: 'ses_1', role: 'user', timeCreated: 1 })
    upsertPart(db, {
      id: 'p1',
      messageId: 'm1',
      sessionId: 'ses_1',
      timeCreated: 1,
      data: textPart('first')
    })
    db.close()

    const state = createOpenCodeNativeChatState()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[][] = []
    const emit = {
      onInitialSnapshot: (messages: NativeChatMessage[]) => snapshots.push(messages),
      onAppend: (messages: NativeChatMessage[]) => appends.push(messages)
    }
    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_1',
      windowLimit: 2,
      state,
      ...emit
    })

    const db2 = new DatabaseSync(path)
    upsertMessage(db2, { id: 'm2', sessionId: 'ses_1', role: 'assistant', timeCreated: 2 })
    upsertPart(db2, {
      id: 'p2',
      messageId: 'm2',
      sessionId: 'ses_1',
      timeCreated: 2,
      data: textPart('reply')
    })
    upsertMessage(db2, { id: 'm3', sessionId: 'ses_1', role: 'user', timeCreated: 3 })
    upsertPart(db2, {
      id: 'p3',
      messageId: 'm3',
      sessionId: 'ses_1',
      timeCreated: 3,
      data: textPart('second ask')
    })
    db2.close()

    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_1',
      windowLimit: 2,
      state,
      ...emit
    })
    // m1 ages out of the 2-wide window; only genuinely new messages append and
    // the already-delivered m1 is never re-emitted (paged history is preserved).
    expect(appends).toHaveLength(1)
    expect(appends[0].map((m) => m.id)).toEqual(['m2', 'm3'])
    expect(appends.flat().map((m) => m.id)).not.toContain('m1')
  })

  it('stays silent on a notFound read and still recovers once the session exists', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    db.close()

    const state = createOpenCodeNativeChatState()
    const snapshots: NativeChatMessage[][] = []
    const errors: string[] = []
    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_new',
      windowLimit: 40,
      state,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) => {
        if (error) {
          errors.push(error)
          return
        }
        snapshots.push(messages)
      },
      onAppend: () => {}
    })
    expect(errors).toEqual([])
    expect(snapshots).toEqual([])

    // The session appears.
    const db2 = new DatabaseSync(path)
    insertSession(db2, 'ses_new')
    upsertMessage(db2, { id: 'm1', sessionId: 'ses_new', role: 'user', timeCreated: 1 })
    upsertPart(db2, {
      id: 'p1',
      messageId: 'm1',
      sessionId: 'ses_new',
      timeCreated: 1,
      data: textPart('hi')
    })
    db2.close()

    await reconcileOpenCodeNativeChat({
      dbPath: path,
      sessionId: 'ses_new',
      windowLimit: 40,
      state,
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) => {
        if (error) {
          errors.push(error)
          return
        }
        snapshots.push(messages)
      },
      onAppend: () => {}
    })
    expect(snapshots[0].map((m) => m.id)).toEqual(['m1'])
  })

  it('notifies once on a persistent schema error', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE session (id TEXT)')
    db.close()

    const state = createOpenCodeNativeChatState()
    const errors: string[] = []
    for (let i = 0; i < 3; i++) {
      await reconcileOpenCodeNativeChat({
        dbPath: path,
        sessionId: 'ses_1',
        windowLimit: 40,
        state,
        onInitialSnapshot: (_messages, _hasMore, _beforeOffset, error) => {
          if (error) {
            errors.push(error)
          }
        },
        onAppend: () => {}
      })
    }
    expect(errors).toEqual(['Transcript unavailable'])
  })

  it('keeps the last good snapshot silent while a corrupt DB recovers', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_1')
    db.close()

    const state = createOpenCodeNativeChatState()
    const errors: string[] = []
    const appends: NativeChatMessage[][] = []
    const reconcile = () =>
      reconcileOpenCodeNativeChat({
        dbPath: path,
        sessionId: 'ses_1',
        windowLimit: 40,
        state,
        onInitialSnapshot: (_messages, _hasMore, _beforeOffset, error) => {
          if (error) {
            errors.push(error)
          }
        },
        onAppend: (messages) => appends.push(messages)
      })

    await reconcile()
    writeFileSync(path, 'not a sqlite database')
    await reconcile()
    expect(errors).toEqual([])
    rmSync(path)

    const repaired = new DatabaseSync(path)
    applyOpenCodeSchema(repaired)
    insertSession(repaired, 'ses_1')
    upsertMessage(repaired, { id: 'm1', sessionId: 'ses_1', role: 'user', timeCreated: 1 })
    upsertPart(repaired, {
      id: 'p1',
      messageId: 'm1',
      sessionId: 'ses_1',
      timeCreated: 1,
      data: textPart('recovered')
    })
    repaired.close()

    await reconcile()
    expect(appends.flat().map((message) => message.id)).toEqual(['m1'])
  })
})

it('aborts SQLite paging when the read signal is canceled', async () => {
  const { db, path } = createTempDb()
  applyOpenCodeSchema(db)
  insertSession(db, 'ses_1')
  upsertMessage(db, { id: 'm1', sessionId: 'ses_1', role: 'user', timeCreated: 1 })
  upsertPart(db, {
    id: 'p1',
    messageId: 'm1',
    sessionId: 'ses_1',
    timeCreated: 1,
    data: textPart('first')
  })
  upsertMessage(db, { id: 'm2', sessionId: 'ses_1', role: 'assistant', timeCreated: 2 })
  upsertPart(db, {
    id: 'p2',
    messageId: 'm2',
    sessionId: 'ses_1',
    timeCreated: 2,
    data: textPart('second')
  })
  db.close()

  const controller = new AbortController()
  let mapped = 0
  await expect(
    readOpenCodeNativeChatTranscript(
      {
        dbPath: path,
        sessionId: 'ses_1',
        limit: 40,
        signal: controller.signal
      },
      (message) => {
        mapped += 1
        if (mapped === 1) {
          controller.abort()
        }
        return [
          {
            id: message.id,
            role: 'user',
            blocks: [{ type: 'text', text: 'mapped' }],
            timestamp: message.time_created,
            source: 'transcript'
          }
        ]
      }
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
})

describe('subscribeOpenCodeNativeChatTranscript', () => {
  it('tears down the poll loop on unsubscribe without leaking watchers', async () => {
    vi.useFakeTimers()
    const { db, path } = createTempDb()
    applyOpenCodeSchema(db)
    insertSession(db, 'ses_1')
    db.close()

    const onAppend = vi.fn()
    const onInitialSnapshot = vi.fn()
    const subscription = subscribeOpenCodeNativeChatTranscript({
      dbPath: path,
      sessionId: 'ses_1',
      initialLimit: 40,
      reconciliationIntervalMs: 10,
      onAppend,
      onInitialSnapshot
    })
    expect(subscription.watching).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(onInitialSnapshot).toHaveBeenCalled()

    onInitialSnapshot.mockClear()
    subscription.unsubscribe()
    await vi.advanceTimersByTimeAsync(200)
    expect(onInitialSnapshot).not.toHaveBeenCalled()
    expect(onAppend).not.toHaveBeenCalled()
  })
  it('returns an inert subscription when the database is unavailable', () => {
    const onAppend = vi.fn()
    const onInitialSnapshot = vi.fn()
    const subscription = subscribeOpenCodeNativeChatTranscript({
      dbPath: null,
      sessionId: 'ses-memory',
      onAppend,
      onInitialSnapshot
    })

    expect(subscription.watching).toBe(false)
    subscription.unsubscribe()
    expect(onAppend).not.toHaveBeenCalled()
    expect(onInitialSnapshot).not.toHaveBeenCalled()
  })
})
