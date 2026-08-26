import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import Database from '../sqlite/sync-database'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-list'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const HOLDER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads'
const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
const db = new DatabaseSync(workerData.dbPath)
db.exec('BEGIN EXCLUSIVE')
parentPort.postMessage('locked')
parentPort.once('message', (message) => {
  if (message !== 'reader-started') throw new Error('Unexpected lock-holder message')
  setTimeout(() => {
    db.exec('COMMIT')
    db.close()
    parentPort.postMessage('committed')
  }, 200)
})
`

async function createDatabase(schema: string): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-sqlite-lock-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'opencode.db')
  const writer = new Database(path)
  writer.exec(schema)
  writer.close()
  return { directory, path }
}

async function holdExclusive(directory: string, dbPath: string): Promise<Worker> {
  const workerPath = join(directory, 'holder.mjs')
  await writeFile(workerPath, HOLDER_SOURCE)
  const worker = new Worker(workerPath, { workerData: { dbPath } })
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.on('message', (message) => {
      if (message === 'locked') {
        resolve()
      }
    })
  })
  return worker
}

describe('OpenCode session SQLite under transient writer contention', () => {
  it('lists sessions after an exclusive writer releases within the timeout', async () => {
    const { directory, path } = await createDatabase(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      INSERT INTO session VALUES ('ses_locked', 1777634000000, 1777634001000);
    `)
    const worker = await holdExclusive(directory, path)
    try {
      worker.postMessage('reader-started')
      const issues: AiVaultScanIssue[] = []
      const candidates = await listOpenCodeSqliteSessions({
        dbPaths: [path],
        limit: 10,
        issues
      })

      expect(issues).toEqual([])
      expect(candidates.map((candidate) => candidate.file.path)).toEqual([
        buildOpenCodeSqliteCandidatePath(path, 'ses_locked')
      ])
    } finally {
      await worker.terminate()
    }
  })

  it('parses a session after an exclusive writer releases within the timeout', async () => {
    const { directory, path } = await createDatabase(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER,
        agent TEXT,
        model TEXT,
        cost REAL DEFAULT 0 NOT NULL,
        tokens_input INTEGER DEFAULT 0 NOT NULL,
        tokens_output INTEGER DEFAULT 0 NOT NULL,
        tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
        tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
        tokens_cache_write INTEGER DEFAULT 0 NOT NULL
      );
      INSERT INTO session (
        id, project_id, slug, directory, title, version,
        time_created, time_updated, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (
        'ses_locked', 'proj-1', 'slug', '/tmp/opencode', 'Locked session', '1.0.0',
        1777634000000, 1777634001000, 0, 1, 1, 0, 0, 0
      );
    `)
    const worker = await holdExclusive(directory, path)
    try {
      worker.postMessage('reader-started')
      const session = await parseOpenCodeSqliteSession({
        dbPath: path,
        sessionId: 'ses_locked',
        platform: 'darwin'
      })

      expect(session).not.toBeNull()
      expect(session?.sessionId).toBe('ses_locked')
      expect(session?.title).toBe('Locked session')
    } finally {
      await worker.terminate()
    }
  })
})
