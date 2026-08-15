import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openReadonlySyncDatabase } from './readonly-sync-database'
import SyncDatabase from './sync-database'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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
parentPort.once('message', (message) => {
  if (message !== 'reader-started') {
    throw new Error('Unexpected lock-holder message')
  }
  setTimeout(() => {
    db.exec('COMMIT')
    db.close()
    parentPort.postMessage('committed')
  }, workerData.releaseDelayMs)
})
`

async function holdExclusive(dbPath: string, releaseDelayMs: number): Promise<Worker> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-worker-'))
  temporaryDirectories.push(directory)
  const workerPath = join(directory, 'holder.mjs')
  await writeFile(workerPath, HOLDER_SOURCE)
  const worker = new Worker(workerPath, { workerData: { dbPath, releaseDelayMs } })
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
      worker.postMessage('reader-started')
      const db = openReadonlySyncDatabase(dbPath, { timeoutMs: 2_000 })
      expect(db.prepare('SELECT id FROM items').get()).toEqual({ id: 1 })
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
      worker.postMessage('reader-started')
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

  it('closes the database when query_only setup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'sessions.db')
    const writer = new SyncDatabase(dbPath)
    writer.exec('CREATE TABLE items (id INTEGER)')
    writer.close()

    const setupError = new Error('query_only setup failed')
    vi.spyOn(SyncDatabase.prototype, 'pragma').mockImplementationOnce(() => {
      throw setupError
    })
    const closeSpy = vi.spyOn(SyncDatabase.prototype, 'close')

    expect(() => openReadonlySyncDatabase(dbPath)).toThrow(setupError)
    expect(closeSpy).toHaveBeenCalledOnce()
  })

  it('preserves the setup error when closing also fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-readonly-sqlite-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'sessions.db')
    const writer = new SyncDatabase(dbPath)
    writer.exec('CREATE TABLE items (id INTEGER)')
    writer.close()

    const setupError = new Error('query_only setup failed')
    const closeError = new Error('close failed')
    const originalClose = SyncDatabase.prototype.close
    vi.spyOn(SyncDatabase.prototype, 'pragma').mockImplementationOnce(() => {
      throw setupError
    })
    vi.spyOn(SyncDatabase.prototype, 'close').mockImplementationOnce(function (this: SyncDatabase) {
      originalClose.call(this)
      throw closeError
    })

    expect(() => openReadonlySyncDatabase(dbPath)).toThrow(setupError)
  })
})
