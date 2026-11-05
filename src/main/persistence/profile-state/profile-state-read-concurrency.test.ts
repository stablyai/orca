import { once } from 'node:events'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { buildRecoveryCrashProcess } from './profile-state-recovery-crash-process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { verifyProfileStateSchema } from './profile-state-database-validation'
import {
  importProfileStateJson,
  readProfileStateSnapshot,
  readProfileStateParsedSnapshot,
  validateProfileStateSnapshot
} from './profile-state-documents'
import { readProfileStateDomainsWithRevisionFromDatabase } from './profile-state-domain-reader'
import * as revisions from './profile-state-revision'

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-read-concurrency-'))
  directories.push(directory)
  const path = join(directory, 'profile-state.db')
  const { db } = openProfileStateDatabase(path, 'profile-a')
  importProfileStateJson(db, '{"automationRuns":[{"id":"run-1","status":"pending"}]}')
  return { path, db }
}

describe('profile state reads during concurrent commits', () => {
  it.each([
    [readProfileStateSnapshot, openProfileStateDatabaseReadOnly],
    [readProfileStateParsedSnapshot, openProfileStateDatabase],
    [validateProfileStateSnapshot, openProfileStateDatabaseReadOnly]
  ] as const)(
    'keeps revision and documents together when a writer commits during %s',
    async (read, open) => {
      const { path, db: writer } = fixture()
      const { db: reader } = open(path, 'profile-a')
      const { bundle } = buildRecoveryCrashProcess(directories.at(-1)!)
      const phase = new Int32Array(new SharedArrayBuffer(4))
      const worker = spawnWorkerThread(
        `
        const { parentPort, workerData } = require('node:worker_threads')
        const api = require(workerData.bundle)
        const writer = api.openProfileStateDatabase(workerData.path, 'profile-a').db
        const phase = new Int32Array(workerData.shared)
        const exec = writer.exec.bind(writer)
        writer.exec = sql => {
          if (sql === 'COMMIT') {
            Atomics.store(phase, 0, 1)
            Atomics.notify(phase, 0)
          }
          return exec(sql)
        }
        parentPort.once('message', () => {
          try {
            api.writeProfileStateDomains(writer, {
              expectedRevision: 1,
              replacements: [{ domain: 'automationRuns', payload: '[]' }]
            })
            parentPort.postMessage('committed')
          } catch (error) {
            parentPort.postMessage(String(error))
          } finally {
            writer.close()
            parentPort.close()
          }
        })
        parentPort.postMessage('ready')
      `,
        { eval: true, workerData: { bundle, path, shared: phase.buffer }, execArgv: [] }
      )
      expect((await once(worker, 'message'))[0]).toBe('ready')
      const completion = once(worker, 'message')
      const readRevision = revisions.readProfileStateRevision
      let attempted = false
      vi.spyOn(revisions, 'readProfileStateRevision').mockImplementation((db) => {
        const revision = readRevision(db)
        if (db === reader && !attempted) {
          attempted = true
          worker.postMessage('write')
          if (Atomics.wait(phase, 0, 0, 5_000) === 'timed-out') {
            throw new Error('Concurrent writer did not begin')
          }
        }
        return revision
      })
      try {
        const snapshot = read(reader)
        expect(attempted).toBe(true)
        if (typeof snapshot === 'number') {
          expect(snapshot).toBe(1)
        } else {
          expect(snapshot).toMatchObject({ revision: 1 })
          expect(snapshot).toMatchObject(
            read === readProfileStateSnapshot
              ? { json: '{"automationRuns":[{"id":"run-1","status":"pending"}]}' }
              : { state: { automationRuns: [{ id: 'run-1', status: 'pending' }] } }
          )
        }
        expect(reader.isTransaction).toBe(false)
        expect((await completion)[0]).toBe('committed')
        const next = read(reader)
        expect(typeof next === 'number' ? next : next.revision).toBe(2)
        if (typeof next !== 'number') {
          expect(next).toMatchObject(
            read === readProfileStateSnapshot
              ? { json: '{"automationRuns":[]}' }
              : { state: { automationRuns: [] } }
          )
        }
      } finally {
        reader.close()
        await worker.terminate()
        writer.close()
      }
    }
  )

  it.each([
    ['read-only', openProfileStateDatabaseReadOnly],
    ['writable', openProfileStateDatabase]
  ] as const)(
    'opens a malformed domain for repair through %s without losing its contents',
    (_, open) => {
      const { path, db: writer } = fixture()
      try {
        writer.exec('DELETE FROM profile_state_automation_runs_meta')
        for (let attempt = 0; attempt < 2; attempt++) {
          const opened = open(path, 'profile-a')
          try {
            expect(() => readProfileStateParsedSnapshot(opened.db)).toThrow('metadata is malformed')
            expect(opened.db.isTransaction).toBe(false)
            expect(
              opened.db.prepare('SELECT domain FROM profile_state_automation_runs_meta').all()
            ).toEqual([])
            expect(
              opened.db.prepare('SELECT run_id, payload FROM profile_state_automation_runs').all()
            ).toEqual([{ run_id: 'run-1', payload: '{"id":"run-1","status":"pending"}' }])
          } finally {
            opened.db.close()
          }
        }
      } finally {
        writer.close()
      }
    }
  )

  it('keeps caller-owned writes uncommitted through schema, full and selected reads', () => {
    const { db } = fixture()
    try {
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run('probe', 'value')
      verifyProfileStateSchema(db, 'profile-a')
      expect(readProfileStateSnapshot(db).revision).toBe(1)
      expect(readProfileStateParsedSnapshot(db).revision).toBe(1)
      expect(readProfileStateDomainsWithRevisionFromDatabase(db, ['automationRuns'])).toEqual({
        kind: 'values',
        revision: 1,
        values: new Map([['automationRuns', [{ id: 'run-1', status: 'pending' }]]])
      })
      expect(db.isTransaction).toBe(true)
      db.exec('ROLLBACK')
      expect(
        db.prepare('SELECT value FROM profile_state_meta WHERE key = ?').get('probe')
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it.each(['owned', 'caller'] as const)(
    'preserves corrupt state and releases only %s read transactions',
    (ownership) => {
      const { db } = fixture()
      try {
        if (ownership === 'caller') {
          db.exec('BEGIN IMMEDIATE')
        }
        db.exec('DELETE FROM profile_state_automation_runs_meta')
        // Why: schema verification is structural so section repair can still open this profile.
        expect(() => verifyProfileStateSchema(db, 'profile-a')).not.toThrow()
        expect(db.isTransaction).toBe(ownership === 'caller')
        expect(() => readProfileStateSnapshot(db)).toThrow('metadata is malformed')
        expect(() => readProfileStateParsedSnapshot(db)).toThrow('metadata is malformed')
        expect(readProfileStateDomainsWithRevisionFromDatabase(db, ['automationRuns']).kind).toBe(
          'unreadable'
        )
        expect(db.isTransaction).toBe(ownership === 'caller')
        expect(db.prepare('SELECT domain FROM profile_state_automation_runs_meta').all()).toEqual(
          []
        )
        if (ownership === 'caller') {
          db.exec('ROLLBACK')
          expect(readProfileStateSnapshot(db).revision).toBe(1)
          expect(readProfileStateParsedSnapshot(db).revision).toBe(1)
        }
      } finally {
        db.close()
      }
    }
  )
})
