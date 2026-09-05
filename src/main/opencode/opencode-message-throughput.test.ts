import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import {
  measureOpenCodeMessageRow,
  readLastOpenCodeMessageThroughput
} from './opencode-message-throughput'

const CREATED = 1_777_777_700_000

const tmpDirs: string[] = []

function createDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-throughput-'))
  tmpDirs.push(dir)
  return join(dir, 'opencode.db')
}

function assistantData(args: {
  output: number
  reasoning?: number
  createdMs: number
  completedMs?: number
  role?: string
}): string {
  return JSON.stringify({
    role: args.role ?? 'assistant',
    providerID: 'openai',
    modelID: 'gpt-5.5',
    tokens: { input: 800, output: args.output, reasoning: args.reasoning ?? 0, cache: { read: 0 } },
    time: {
      created: args.createdMs,
      ...(args.completedMs === undefined ? {} : { completed: args.completedMs })
    }
  })
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('opencode message throughput', () => {
  it('measures a row from its own created → completed span, counting reasoning as output', () => {
    expect(
      measureOpenCodeMessageRow({
        id: 'msg-1',
        data: assistantData({
          output: 200,
          reasoning: 50,
          createdMs: CREATED,
          completedMs: CREATED + 5_000
        }),
        time_created: CREATED
      })
    ).toEqual({
      messageId: 'msg-1',
      model: 'openai/gpt-5.5',
      outputTokens: 250,
      generationMs: 5_000,
      completedAt: CREATED + 5_000
    })
    // Why: OpenCode stores seconds in some generations; both must land on the same clock.
    expect(
      measureOpenCodeMessageRow({
        id: 'msg-2',
        data: assistantData({ output: 10, createdMs: 1_777_777_700, completedMs: 1_777_777_702 }),
        time_created: null
      })
    ).toMatchObject({ generationMs: 2_000 })
    expect(
      measureOpenCodeMessageRow({
        id: 'msg-3',
        data: assistantData({ output: 10, createdMs: CREATED }),
        time_created: CREATED
      })
    ).toBe(undefined)
    expect(measureOpenCodeMessageRow({ id: 'msg-4', data: '{bad', time_created: null })).toBe(
      undefined
    )
  })

  it('reads the newest completed assistant message of a session from a message table', async () => {
    const path = createDatabasePath()
    const db = new SyncDatabase(path)
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `)
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run(
      'm-user',
      's1',
      CREATED,
      CREATED,
      JSON.stringify({ role: 'user', time: { created: CREATED } })
    )
    insert.run(
      'm-1',
      's1',
      CREATED + 1_000,
      CREATED + 4_000,
      assistantData({ output: 300, createdMs: CREATED + 1_000, completedMs: CREATED + 4_000 })
    )
    insert.run(
      'm-2',
      's1',
      CREATED + 10_000,
      CREATED + 10_000,
      assistantData({ output: 40, createdMs: CREATED + 10_000 })
    )
    insert.run(
      'm-other',
      's2',
      CREATED + 20_000,
      CREATED + 21_000,
      assistantData({ output: 999, createdMs: CREATED + 20_000, completedMs: CREATED + 21_000 })
    )
    db.close()

    // Why: m-2 is still streaming (no completed stamp), so the last finished message wins.
    await expect(
      readLastOpenCodeMessageThroughput('s1', { databasePaths: [path] })
    ).resolves.toMatchObject({ messageId: 'm-1', outputTokens: 300, generationMs: 3_000 })
    await expect(
      readLastOpenCodeMessageThroughput('missing', { databasePaths: [path] })
    ).resolves.toBe(undefined)
  })

  it('reads typed session_message rows and tolerates unreadable databases', async () => {
    const path = createDatabasePath()
    const db = new SyncDatabase(path)
    db.exec(`
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `)
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'sm-1',
      's1',
      'assistant',
      CREATED,
      CREATED + 2_500,
      assistantData({ output: 100, createdMs: CREATED, completedMs: CREATED + 2_500 })
    )
    db.close()

    await expect(
      readLastOpenCodeMessageThroughput('s1', {
        databasePaths: [join(tmpdir(), 'missing.db'), path]
      })
    ).resolves.toMatchObject({ messageId: 'sm-1', generationMs: 2_500 })
  })
})
