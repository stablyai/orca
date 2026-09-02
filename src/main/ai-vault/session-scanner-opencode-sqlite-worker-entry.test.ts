import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  applyOpenCodeSqliteSchema,
  insertOpenCodeMessage,
  insertOpenCodePart,
  insertOpenCodeSession
} from './session-scanner-opencode-sqlite-fixtures'
import type {
  OpenCodeSqliteParseValue,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'

// A parent-port stand-in: the entry registers on it at import time, so the test
// drives the worker loop without spawning a thread.
const posted: OpenCodeSqliteWorkerResponse[] = []
let handler: ((request: OpenCodeSqliteWorkerRequest) => void) | null = null

vi.mock('node:worker_threads', () => ({
  parentPort: {
    on(event: string, listener: (request: OpenCodeSqliteWorkerRequest) => void) {
      if (event === 'message') {
        handler = listener
      }
    },
    postMessage(response: OpenCodeSqliteWorkerResponse) {
      posted.push(response)
    }
  }
}))

const SESSION_ID = 'ses_worker00000000000000000000'
const CREATED_MS = 1_777_634_000_000

let tempDirs: string[] = []

beforeEach(async () => {
  posted.length = 0
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
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  const response = posted[0]!
  if (!response.ok) {
    throw new Error(response.error)
  }
  return response.value as OpenCodeSqliteParseValue
}

describe('OpenCode SQLite worker entry', () => {
  it('returns the parsed session with its captured index rows', async () => {
    const value = await parseOnWorker(createDbWithOneTurn(), true)

    expect(value.session?.sessionId).toBe(SESSION_ID)
    expect(value.messages).toEqual([
      { role: 'user', text: 'recalibrate the ballast pump', timestamp: expect.any(String) }
    ])
  })

  it('skips capture when the caller did not ask for it', async () => {
    const value = await parseOnWorker(createDbWithOneTurn(), false)

    expect(value.session?.sessionId).toBe(SESSION_ID)
    expect(value.messages).toEqual([])
  })
})
