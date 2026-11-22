import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import Database from '../../../../sqlite/sync-database'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { readOpenCodeDatabase } from './session-scanner-opencode-sqlite-open'

// A writer lock previously failed immediately and emptied both scan scopes (#15036).

let tempDirs: string[] = []
let lockHolders: Worker[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(lockHolders.splice(0).map((worker) => worker.terminate()))
  lockHolders = []
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

const SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  )
`

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-open-'))
  tempDirs.push(dir)
  return dir
}

function seededDatabase(name: string, sessionId: string): string {
  const path = join(tempDir(), name)
  const db = new Database(path)
  db.exec('PRAGMA journal_mode=DELETE')
  db.exec(SCHEMA)
  db.prepare('INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)').run(
    sessionId,
    1_700_000_000_000,
    1_700_000_001_000
  )
  db.close()
  return path
}

const LOCK_HOLDER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(workerData.path)
  db.exec('BEGIN EXCLUSIVE')
  db.exec("INSERT INTO session (id, time_created, time_updated) VALUES ('locked-write', 1, 1)")
  parentPort.ref()
  parentPort.postMessage('locked')
`

async function holdWriteLock(path: string): Promise<void> {
  const worker = new Worker(LOCK_HOLDER_SOURCE, {
    eval: true,
    workerData: { path }
  })
  lockHolders.push(worker)
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
}

describe('listOpenCodeSqliteSessions against a database OpenCode is writing to', () => {
  it('reports the failure as a whole source, not as a skipped transcript', async () => {
    const path = seededDatabase('opencode.db', 'session-a')
    await holdWriteLock(path)
    const issues: AiVaultScanIssue[] = []

    const candidates = await listOpenCodeSqliteSessions({ dbPaths: [path], limit: 10, issues })

    expect(candidates).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.kind).toBe('scope')
    expect(issues[0]?.message).toContain('OpenCode is writing to opencode.db')
    expect(issues[0]?.message).not.toBe('database is locked')
  })

  it('still returns sessions from every other database', async () => {
    const contended = seededDatabase('opencode.db', 'session-a')
    const healthy = seededDatabase('opencode-alt.db', 'session-b')
    await holdWriteLock(contended)
    const issues: AiVaultScanIssue[] = []

    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [contended, healthy],
      limit: 10,
      issues
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.file.path).toContain('session-b')
    expect(issues).toHaveLength(1)
  })
})

describe('readOpenCodeDatabase', () => {
  it('closes the handle on the success path', () => {
    const path = seededDatabase('opencode.db', 'session-a')
    let captured: Database.Database | null = null

    const rows = readOpenCodeDatabase({
      dbPath: path,
      read: (db) => {
        captured = db
        return db.prepare('SELECT id FROM session').all()
      }
    })

    expect(rows).toEqual([{ id: 'session-a' }])
    expect(() => captured!.prepare('SELECT 1')).toThrow(/not open/i)
  })

  it('closes the handle when query_only setup fails', () => {
    const path = seededDatabase('opencode.db', 'session-a')
    const setupError = new Error('query_only setup failed')
    const originalClose = Database.prototype.close
    const pragmaSpy = vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(() => {
      throw setupError
    })
    const closeSpy = vi.spyOn(Database.prototype, 'close')
    const read = vi.fn()

    try {
      expect(() => readOpenCodeDatabase({ dbPath: path, read })).toThrow(setupError)
      expect(read).not.toHaveBeenCalled()
      expect(closeSpy).toHaveBeenCalledOnce()
      expect(() => (pragmaSpy.mock.contexts[0] as Database).prepare('SELECT 1')).toThrow(
        /not open/i
      )
    } finally {
      try {
        originalClose.call(pragmaSpy.mock.contexts[0] as Database)
      } catch {
        // Keep the regression safe to run against the leaking implementation too.
      }
    }
  })

  it('closes the handle when the read throws', () => {
    const path = seededDatabase('opencode.db', 'session-a')
    let captured: Database.Database | null = null

    expect(() =>
      readOpenCodeDatabase({
        dbPath: path,
        read: (db) => {
          captured = db
          throw new Error('read blew up')
        }
      })
    ).toThrow('read blew up')
    expect(() => captured!.prepare('SELECT 1')).toThrow(/not open/i)
  })
})
