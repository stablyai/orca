import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import Database from '../sqlite/sync-database'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import {
  openCodeBusyTimeoutMs,
  openCodeDatabaseScanIssue,
  readOpenCodeDatabase
} from './session-scanner-opencode-sqlite-open'

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

// SQLite busy waits block the thread, so only another thread can release the lock during a read.
const LOCK_HOLDER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(workerData.path)
  db.exec('BEGIN EXCLUSIVE')
  db.exec("INSERT INTO session (id, time_created, time_updated) VALUES ('locked-write', 1, 1)")
  parentPort.postMessage('locked')
  parentPort.once('message', (message) => {
    if (message !== 'reader-started') {
      throw new Error('Unexpected lock-holder message')
    }
    setTimeout(() => {
      db.exec('ROLLBACK')
      db.close()
      parentPort.postMessage('released')
    }, workerData.releaseDelayMs)
  })
`

async function holdWriteLock(path: string, releaseDelayMs: number): Promise<Worker> {
  const worker = new Worker(LOCK_HOLDER_SOURCE, {
    eval: true,
    workerData: { path, releaseDelayMs }
  })
  lockHolders.push(worker)
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return worker
}

describe('listOpenCodeSqliteSessions against a database OpenCode is writing to', () => {
  it('reports the failure as a whole source, not as a skipped transcript', async () => {
    const path = seededDatabase('opencode.db', 'session-a')
    await holdWriteLock(path, 60_000)
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
    await holdWriteLock(contended, 60_000)
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

  it('reads the sessions once the write finishes inside the busy timeout', async () => {
    const path = seededDatabase('opencode.db', 'session-a')
    const worker = await holdWriteLock(path, 200)
    const issues: AiVaultScanIssue[] = []
    worker.postMessage('reader-started')

    const candidates = await listOpenCodeSqliteSessions({ dbPaths: [path], limit: 10, issues })

    expect(issues).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.file.path).toContain('session-a')
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

  it('preserves the setup error when closing also fails', () => {
    const path = seededDatabase('opencode.db', 'session-a')
    const setupError = new Error('query_only setup failed')
    const closeError = new Error('close failed')
    const originalClose = Database.prototype.close
    vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(() => {
      throw setupError
    })
    vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database) {
      originalClose.call(this)
      throw closeError
    })

    const read = vi.fn()
    expect(() => readOpenCodeDatabase({ dbPath: path, read })).toThrow(setupError)
    expect(Database.prototype.close).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps the query-only guard enabled for successful reads', () => {
    const path = seededDatabase('opencode.db', 'session-a')
    readOpenCodeDatabase({
      dbPath: path,
      read: (db) => {
        expect(db.pragma('query_only', { simple: true })).toBe(1)
        expect(() => db.exec('DELETE FROM session')).toThrow(/readonly/i)
        expect(db.prepare('SELECT id FROM session').all()).toEqual([{ id: 'session-a' }])
      }
    })
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

describe('openCodeBusyTimeoutMs', () => {
  // WSL-share lock failures persist across timeouts; observed waits can also exceed the requested duration.
  it('does not wait on a share where the wait provably cannot succeed', () => {
    expect(openCodeBusyTimeoutMs('\\\\wsl.localhost\\Ubuntu\\home\\ada\\opencode.db')).toBe(0)
    expect(openCodeBusyTimeoutMs('\\\\wsl$\\Ubuntu\\home\\ada\\opencode.db')).toBe(0)
  })

  it('still waits on a path where a writer really can be holding the lock', () => {
    expect(openCodeBusyTimeoutMs('C:\\Users\\ada\\opencode.db')).toBe(1_500)
    expect(openCodeBusyTimeoutMs('/home/ada/.local/share/opencode/opencode.db')).toBe(1_500)
  })
})

describe('openCodeDatabaseScanIssue', () => {
  const cantOpen = Object.assign(new Error('unable to open database file'), { errcode: 14 })

  it('states the WSL share as a known limitation rather than an error to act on', () => {
    const dbPath = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\opencode\\opencode.db'
    const issue = openCodeDatabaseScanIssue(dbPath, cantOpen)

    expect(issue.kind).toBe('scope')
    expect(issue.path).toBe(dbPath)
    expect(issue.message).toBe("OpenCode sessions inside WSL can't be searched from Windows yet.")
    // Checkpointing cannot fix WSL-share locking; the diagnostic must not suggest flushing the WAL.
    expect(issue.message).not.toContain('write-ahead log')
  })

  it('keeps the advice generic for a non-WSL path', () => {
    const issue = openCodeDatabaseScanIssue('/home/ada/.local/share/opencode/opencode.db', cantOpen)

    expect(issue.message).not.toContain('wsl.localhost')
    expect(issue.message).toContain('write-ahead log')
  })

  // Real WSL-share reads fail even for idle non-WAL databases whose bytes open successfully on local disk.
  it('does not blame a live writer for a lock-family error over a WSL share', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 })
    const issue = openCodeDatabaseScanIssue(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\opencode\\opencode.db',
      busy
    )

    expect(issue.message).not.toContain('is writing to')
    expect(issue.message).toBe("OpenCode sessions inside WSL can't be searched from Windows yet.")
  })

  it('still blames a live writer for the same error on a local path', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 })
    const issue = openCodeDatabaseScanIssue('/home/ada/.local/share/opencode/opencode.db', busy)

    expect(issue.message).toContain('is writing to')
  })

  it('reports anything else with its underlying cause', () => {
    const issue = openCodeDatabaseScanIssue(
      '/home/ada/.local/share/opencode/opencode.db',
      Object.assign(new Error('database disk image is malformed'), { errcode: 11 })
    )

    expect(issue.kind).toBe('scope')
    expect(issue.message).not.toContain('write-ahead log')
    expect(issue.message).toContain('database disk image is malformed')
  })
})
