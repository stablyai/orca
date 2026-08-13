import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { openReadonlySyncDatabase } from './readonly-sync-database'
import SyncDatabase from './sync-database'

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
db.exec('CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1)')
db.exec('BEGIN EXCLUSIVE')
parentPort.postMessage('locked')
setTimeout(() => {
  db.exec('COMMIT')
  db.close()
  parentPort.postMessage('committed')
}, workerData.holdMs)
`

async function holdExclusive(dbPath: string, holdMs: number): Promise<Worker> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-worker-'))
  temporaryDirectories.push(directory)
  const workerPath = join(directory, 'holder.mjs')
  await writeFile(workerPath, HOLDER_SOURCE)
  const worker = new Worker(workerPath, { workerData: { dbPath, holdMs } })
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

describe('openReadonlySyncDatabase', () => {
  it('reads after a concurrent exclusive writer releases within the busy timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'sessions.db')
    const worker = await holdExclusive(dbPath, 200)
    try {
      const started = Date.now()
      const db = openReadonlySyncDatabase(dbPath, { timeoutMs: 2_000 })
      expect(db.prepare('SELECT id FROM items').get()).toEqual({ id: 1 })
      expect(Date.now() - started).toBeGreaterThanOrEqual(150)
      db.close()
    } finally {
      await worker.terminate()
    }
  })

  it('fails when the exclusive writer outlives a short busy timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'sessions.db')
    const worker = await holdExclusive(dbPath, 2_000)
    try {
      expect(() => {
        const db = openReadonlySyncDatabase(dbPath, { timeoutMs: 50 })
        try {
          db.prepare('SELECT id FROM items').get()
        } finally {
          db.close()
        }
      }).toThrow(/database is locked/i)
    } finally {
      await worker.terminate()
    }
  })

  it('keeps query_only so a readonly handle cannot mutate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'sessions.db')
    const writer = new SyncDatabase(dbPath)
    writer.exec('CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (1)')
    writer.close()

    const db = openReadonlySyncDatabase(dbPath)
    expect(() => db.exec('INSERT INTO items VALUES (2)')).toThrow()
    db.close()
  })
})
