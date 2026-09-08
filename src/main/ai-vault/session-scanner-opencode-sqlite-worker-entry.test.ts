import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import { withStreamingSessionSearchCapture } from './session-search-capture'
import {
  applyOpenCodeSqliteSchema,
  insertOpenCodeMessage,
  insertOpenCodePart,
  insertOpenCodeSession
} from './session-scanner-opencode-sqlite-fixtures'
import type {
  OpenCodeSqliteParseValue,
  OpenCodeSqliteParentMessage,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'

// A parent-port stand-in: the entry registers on it at import time, so the test
// drives the worker loop without spawning a thread.
const posted: OpenCodeSqliteWorkerResponse[] = []
let acknowledge = true
let handler: ((request: OpenCodeSqliteParentMessage) => void) | null = null

vi.mock('node:worker_threads', () => ({
  parentPort: {
    on(event: string, listener: (request: OpenCodeSqliteParentMessage) => void) {
      if (event === 'message') {
        handler = listener
      }
    },
    postMessage(response: OpenCodeSqliteWorkerResponse) {
      posted.push(response)
      if (acknowledge && response.kind === 'batch') {
        queueMicrotask(() =>
          handler?.({ id: response.id, kind: 'captureAck', batch: response.batch })
        )
      }
    }
  }
}))

const SESSION_ID = 'ses_worker00000000000000000000'
const CREATED_MS = 1_777_634_000_000

let tempDirs: string[] = []

beforeEach(async () => {
  posted.length = 0
  acknowledge = true
  await import('./session-scanner-opencode-sqlite-worker-entry')
})

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createDbWithOneTurn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-worker-entry-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  applyOpenCodeSqliteSchema(db)
  insertOpenCodeSession(db, {
    id: SESSION_ID,
    timeCreated: CREATED_MS,
    timeUpdated: CREATED_MS + 1_000
  })
  insertOpenCodeMessage(db, {
    id: 'msg_1',
    sessionId: SESSION_ID,
    role: 'user',
    timeCreated: CREATED_MS + 500
  })
  insertOpenCodePart(db, {
    id: 'prt_1',
    messageId: 'msg_1',
    sessionId: SESSION_ID,
    timeCreated: CREATED_MS + 500,
    text: 'recalibrate the ballast pump'
  })
  db.close()
  return path
}

async function parseOnWorker(dbPath: string, capture: boolean): Promise<OpenCodeSqliteParseValue> {
  handler?.({ id: 1, kind: 'parse', dbPath, sessionId: SESSION_ID, platform: 'darwin', capture })
  await vi.waitFor(() => expect(posted.some((reply) => reply.kind !== 'batch')).toBe(true))
  const response = posted.at(-1)!
  if (response.kind === 'error') {
    throw new Error(response.error)
  }
  if (response.kind !== 'result') {
    throw new Error('worker replied with a capture batch instead of a result')
  }
  return response.value as OpenCodeSqliteParseValue
}

describe('OpenCode SQLite worker entry', () => {
  it('returns the parsed session with its captured index rows', async () => {
    const value = await parseOnWorker(createDbWithOneTurn(), true)

    expect(value.session?.sessionId).toBe(SESSION_ID)
    expect(posted.flatMap((reply) => (reply.kind === 'batch' ? reply.messages : []))).toEqual([
      { role: 'user', text: 'recalibrate the ballast pump', timestamp: expect.any(String) }
    ])
  })

  it('reports a degraded capture read so the parent refuses the file cursor', async () => {
    const dbPath = createDbWithOneTurn()
    const prepare = Database.prototype.prepare
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database,
      sql: string
    ) {
      const statement = prepare.call(this, sql)
      if (!sql.includes('p.data AS data')) {
        return statement
      }
      return {
        iterate: () => {
          throw new Error('disk I/O error')
        }
      } as unknown as ReturnType<typeof prepare>
    })
    try {
      const value = await parseOnWorker(dbPath, true)

      // The scope the producer marked ends with the parse, so the flag has to
      // ride the result across the thread hop.
      expect(value).toMatchObject({ captureIncomplete: true })
      expect(value.session?.sessionId).toBe(SESSION_ID)
    } finally {
      spy.mockRestore()
    }
  })

  it('skips capture when the caller did not ask for it', async () => {
    const value = await parseOnWorker(createDbWithOneTurn(), false)

    expect(value.session?.sessionId).toBe(SESSION_ID)
    expect(posted.flatMap((reply) => (reply.kind === 'batch' ? reply.messages : []))).toEqual([])
  })
})

it('waits for downstream acknowledgement between bounded batches without dropping the tail', async () => {
  const dbPath = createDbWithOneTurn()
  const db = new Database(dbPath)
  const count = 256
  const text = 'bounded history '.repeat(4096)
  db.exec('BEGIN')
  for (let i = 0; i < count; i++) {
    insertOpenCodePart(db, {
      id: `part_${i}`,
      messageId: 'msg_1',
      sessionId: SESSION_ID,
      timeCreated: CREATED_MS + 600 + i,
      text: `${i} ${text}`
    })
  }
  db.exec('COMMIT')
  db.close()
  acknowledge = false
  handler?.({
    id: 2,
    kind: 'parse',
    dbPath,
    sessionId: SESSION_ID,
    platform: process.platform,
    capture: true
  })
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  const first = posted[0]!
  expect(first).toMatchObject({ kind: 'batch', batch: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(posted).toHaveLength(1)
  acknowledge = true
  handler?.({ id: 2, kind: 'captureAck', batch: 1 })
  await vi.waitFor(() =>
    expect(posted.at(-1)).toMatchObject({
      kind: 'result',
      value: { session: { sessionId: SESSION_ID } }
    })
  )
  const batches = posted.flatMap((reply) => (reply.kind === 'batch' ? [reply.messages] : []))
  expect(batches.length).toBeGreaterThan(2)
  expect(batches.flat()).toHaveLength(count + 1)
  expect(batches.flat().at(-1)?.text).toBe(`${count - 1} ${text}`.trim())
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(129)
    expect(batch.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThan(512 * 1024)
  }
})

it('closes its source database if downstream capture fails while the cursor is suspended', async () => {
  const dbPath = createDbWithOneTurn()
  const close = vi.spyOn(Database.prototype, 'close')
  try {
    await expect(
      withStreamingSessionSearchCapture(
        {
          push() {},
          checkpoint: async () => {
            throw new Error('downstream failed')
          }
        },
        () =>
          parseOpenCodeSqliteSession({ dbPath, sessionId: SESSION_ID, platform: process.platform })
      )
    ).rejects.toThrow('downstream failed')
    expect(close).toHaveBeenCalledOnce()
  } finally {
    close.mockRestore()
  }
})
