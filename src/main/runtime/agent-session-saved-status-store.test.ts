import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
  type StructuredAgentSessionSavedStatus
} from '../../shared/structured-agent-session-saved-status'
import Database from '../sqlite/sync-database'
import {
  AGENT_SESSION_SAVED_STATUS_FILE,
  AgentSessionSavedStatusStore
} from './agent-session-saved-status-store'

let dirs: string[] = []
let stores: AgentSessionSavedStatusStore[] = []

afterEach(() => {
  stores.forEach((store) => store.close())
  stores = []
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  dirs = []
  vi.restoreAllMocks()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-saved-status-'))
  dirs.push(dir)
  return dir
}

function open(dir: string): AgentSessionSavedStatusStore {
  const store = AgentSessionSavedStatusStore.open(dir)
  stores.push(store)
  return store
}

function saved(sequence: number, latestPrompt = 'hello'): StructuredAgentSessionSavedStatus {
  return {
    v: STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
    cursor: { epoch: 'epoch-a', sequence },
    projection: { status: 'idle', latestPrompt, lastAssistantMessage: 'done' },
    lastActivityAt: 1_000 + sequence
  }
}

/** Holds the file's write lock from another thread. Once `flushing` is signalled it keeps the lock
 *  a further 300 ms and commits: a flush that waits on the lock succeeds, one that skips does not. */
async function holdWriteLock(path: string) {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
     const { DatabaseSync } = require('node:sqlite')
     const db = new DatabaseSync(workerData.path)
     db.exec('BEGIN IMMEDIATE')
     parentPort.postMessage('locked')
     Atomics.wait(workerData.signal, 0, 0)
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
     db.exec('COMMIT')
     db.close()`,
    { eval: true, workerData: { path, signal } }
  )
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return {
    flushing: () => {
      Atomics.store(signal, 0, 1)
      Atomics.notify(signal, 0)
    },
    exited: new Promise<void>((resolve) => worker.once('exit', () => resolve()))
  }
}

describe('saved chat status store', () => {
  it('reads back what it wrote after a reopen', () => {
    const dir = tempDir()
    const store = open(dir)
    store.record('s1', saved(10))
    expect(store.read('s1')).toEqual(saved(10))
    store.close()
    expect(open(dir).read('s1')).toEqual(saved(10))
  })

  it('writes many coalesced entries in one transaction, and flushes at close', () => {
    const dir = tempDir()
    const store = open(dir)
    const exec = vi.spyOn(Database.prototype, 'exec')
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      store.record('s1', saved(sequence))
      store.record('s2', saved(sequence, 'other'))
    }
    expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(0)
    store.close()
    expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
    const reopened = open(dir)
    expect(reopened.read('s1')).toEqual(saved(20))
    expect(reopened.read('s2')).toEqual(saved(20, 'other'))
  })

  it('skips a flush at once while another process holds the lock, and the next flush writes', async () => {
    const dir = tempDir()
    const store = open(dir)
    store.record('s1', saved(10))
    const lock = await holdWriteLock(join(dir, AGENT_SESSION_SAVED_STATUS_FILE))
    lock.flushing()
    // A flush that waited on the lock would outlast the holder and succeed; a skip answers false.
    expect(store.flush()).toBe(false)
    await lock.exited
    expect(store.flush()).toBe(true)
    store.close()
    expect(open(dir).read('s1')).toEqual(saved(10))
  })

  it('deletes and recreates a file that is not a database, and later writes land', () => {
    const dir = tempDir()
    writeFileSync(join(dir, AGENT_SESSION_SAVED_STATUS_FILE), Buffer.alloc(8192, 7))
    const store = open(dir)
    expect(store.enabled).toBe(true)
    store.record('s1', saved(3))
    store.close()
    expect(open(dir).read('s1')).toEqual(saved(3))
  })

  it('leaves a newer build’s file untouched and reads or writes nothing from it', () => {
    const dir = tempDir()
    const path = join(dir, AGENT_SESSION_SAVED_STATUS_FILE)
    const newer = new Database(path)
    newer.exec('CREATE TABLE later (x INTEGER)')
    newer.pragma('user_version = 99')
    newer.close()
    const before = readFileSync(path)
    const store = open(dir)
    expect(store.enabled).toBe(false)
    store.record('s1', saved(3))
    expect(store.read('s1')).toBeNull()
    store.close()
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('prunes entries whose chat is gone', () => {
    const dir = tempDir()
    const store = open(dir)
    store.record('keep', saved(1))
    store.record('gone', saved(1))
    store.flush()
    store.prune((sessionId) => sessionId === 'keep')
    store.close()
    const reopened = open(dir)
    expect(reopened.read('keep')).toEqual(saved(1))
    expect(reopened.read('gone')).toBeNull()
  })
})
