import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import Database from '../sqlite/sync-database'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import {
  openCodeBusyTimeoutMs,
  openCodeDatabaseScanIssue,
  readOpenCodeDatabase
} from './session-scanner-opencode-sqlite-open'

// Reproduces #15036: OpenCode holds opencode.db open while it runs, so a scan
// lands mid-write. The reader had no busy timeout, failed in ~1 ms with the bare
// driver string "database is locked", and one failed DB emptied both scopes.

let tempDirs: string[] = []
let lockHolders: Worker[] = []

afterEach(async () => {
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

// The lock holder must live on another thread: sqlite3_busy_timeout sleeps
// synchronously, so a same-thread timer could never fire to release it.
const LOCK_HOLDER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(workerData.path)
  db.exec('BEGIN EXCLUSIVE')
  db.exec("INSERT INTO session (id, time_created, time_updated) VALUES ('locked-write', 1, 1)")
  parentPort.postMessage('locked')
  setTimeout(() => {
    db.exec('ROLLBACK')
    db.close()
    parentPort.postMessage('released')
  }, workerData.holdMs)
`

async function holdWriteLock(path: string, holdMs: number): Promise<void> {
  const worker = new Worker(LOCK_HOLDER_SOURCE, { eval: true, workerData: { path, holdMs } })
  lockHolders.push(worker)
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
}

describe('listOpenCodeSqliteSessions against a database OpenCode is writing to', () => {
  it('reports the failure as a whole source, not as a skipped transcript', async () => {
    const path = seededDatabase('opencode.db', 'session-a')
    await holdWriteLock(path, 60_000)
    const issues: AiVaultScanIssue[] = []

    const candidates = await listOpenCodeSqliteSessions({ dbPaths: [path], limit: 10, issues })

    expect(candidates).toEqual([])
    expect(issues).toHaveLength(1)
    // The panel counts only unkinded issues as skipped transcripts.
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
    // Long enough that only a real busy timeout — not a lucky fast open — survives it.
    await holdWriteLock(path, 900)
    const issues: AiVaultScanIssue[] = []

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
  // Measured on a real Windows host against a real distro: a read over
  // \\wsl.localhost fails whatever the timeout, and the wait is not bounded by
  // it -- 1500 took ~2400 ms, 5000 took ~7250 ms, 0 failed in ~21 ms. Waiting
  // there is dead time on every scan, and enough such databases would spend the
  // list worker's whole deadline.
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

  it('names the wal-index over a WSL share rather than repeating the driver string', () => {
    const issue = openCodeDatabaseScanIssue(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\opencode\\opencode.db',
      cantOpen
    )

    expect(issue.kind).toBe('scope')
    expect(issue.message).toContain('\\\\wsl.localhost')
    // Checkpointing cannot fix a share that refuses SQLite's locks, so the copy
    // must not send the user after the write-ahead log.
    expect(issue.message).not.toContain('write-ahead log')
  })

  it('keeps the advice generic for a non-WSL path', () => {
    const issue = openCodeDatabaseScanIssue('/home/ada/.local/share/opencode/opencode.db', cantOpen)

    expect(issue.message).not.toContain('wsl.localhost')
    expect(issue.message).toContain('write-ahead log')
  })

  // Measured against a real Ubuntu-24.04 distro: Windows cannot take SQLite's
  // locks over \\wsl.localhost at all. An idle, never-WAL database answers
  // SQLITE_BUSY the same way, while the identical bytes read fine once copied
  // to local disk — so no busy timeout and no journal mode changes the outcome.
  it('does not blame a live writer for a lock-family error over a WSL share', () => {
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 })
    const issue = openCodeDatabaseScanIssue(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\opencode\\opencode.db',
      busy
    )

    expect(issue.message).not.toContain('is writing to')
    expect(issue.message).toContain('inside the distro')
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
