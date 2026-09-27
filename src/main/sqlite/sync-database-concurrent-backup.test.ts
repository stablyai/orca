import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import SyncDatabase from './sync-database'

const WRITER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  const Database = process.versions.bun
    ? require('bun:sqlite').Database
    : require('node:sqlite').DatabaseSync
  const db = new Database(workerData.path)
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL')
  const count = new Int32Array(workerData.count)
  let revision = 0
  function commit() {
    revision += 1
    db.exec('BEGIN IMMEDIATE; UPDATE marker SET revision=' + revision + '; COMMIT')
    Atomics.store(count, 0, revision)
    if (revision === 1) {
      parentPort.once('message', commit)
      parentPort.postMessage('writing')
      return
    }
    if (revision < 40) setTimeout(commit, 2)
    else { db.close(true); parentPort.close() }
  }
  commit()
`

it('backs up one complete revision while another thread commits to the WAL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sqlite-concurrent-backup-'))
  const path = join(directory, 'source.db')
  const target = join(directory, 'snapshot.db')
  const source = new SyncDatabase(path)
  let writer: Worker | undefined
  let snapshot: SyncDatabase | undefined
  try {
    source.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE marker(name TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      INSERT INTO marker VALUES('first',0),('second',0);
      CREATE TABLE payload(id INTEGER PRIMARY KEY, value BLOB NOT NULL);
      WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM rows WHERE id<1024)
      INSERT INTO payload SELECT id, zeroblob(65536) FROM rows;
    `)
    const sharedCount = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const count = new Int32Array(sharedCount)
    writer = new Worker(WRITER_SOURCE, { eval: true, workerData: { path, count: sharedCount } })
    const firstCommit = new Promise<void>((resolve, reject) => {
      writer?.once('message', () => resolve())
      writer?.once('error', reject)
    })
    const writerExit = new Promise<void>((resolve, reject) => {
      writer?.once('error', reject)
      writer?.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Writer exited ${code}`))
      )
    })
    // Attach failure handling before awaiting either event.
    void writerExit.catch(() => {})
    await firstCommit
    const before = Atomics.load(count, 0)
    // Keep the writer alive until this thread is ready to start the backup.
    writer.postMessage('continue')
    await source.backup(target)
    const after = Atomics.load(count, 0)
    expect(after).toBeGreaterThan(before)
    await writerExit
    snapshot = new SyncDatabase(target, { readonly: true, fileMustExist: true })
    const rows = snapshot.prepare('SELECT revision FROM marker ORDER BY name').all()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(rows[1])
    expect(rows[0]?.revision).toBeGreaterThanOrEqual(before)
    expect(rows[0]?.revision).toBeLessThanOrEqual(Atomics.load(count, 0))
    expect(snapshot.prepare('SELECT count(*) AS count FROM payload').get()).toEqual({ count: 1024 })
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally {
    await writer?.terminate()
    snapshot?.close()
    source.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
