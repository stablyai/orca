import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ProfileStateBackupRotation } from './profile-state-backup-rotation'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateSnapshot
} from './profile-state-documents'
import {
  runProfileStateBackupWorker,
  resolveProfileStateBackupWorkerPath
} from './profile-state-backup-worker'
import * as backupWorker from './profile-state-backup-worker'

const directories: string[] = []
let workerDirectory: string
let workerPath: string

beforeAll(async () => {
  workerDirectory = mkdtempSync(join(tmpdir(), 'orca-backup-worker-entry-'))
  workerPath = join(workerDirectory, 'profile-state-backup-worker-entry.js')
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts')
    ],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

afterAll(() => rmSync(workerDirectory, { recursive: true, force: true }))

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-backup-worker-'))
  directories.push(directory)
  const job = {
    databasePath: join(directory, 'profile-state.db'),
    targetPath: join(directory, 'backup.db'),
    profileId: 'worker-test'
  }
  const opened = openProfileStateDatabase(job.databasePath, job.profileId)
  importProfileStateJson(opened.db, '{"settings":{"theme":"dark"}}')
  opened.db.close()
  return { directory, job }
}

function script(directory: string, source: string): string {
  const path = join(directory, 'worker.cjs')
  writeFileSync(path, source)
  return path
}

describe('profile state backup worker', () => {
  it('runs the built entry and releases every handle before recovery can move its files', async () => {
    const { directory, job } = fixture()
    await runProfileStateBackupWorker(job, { workerPath })
    const snapshot = openProfileStateDatabaseReadOnly(job.targetPath, job.profileId)
    try {
      expect(JSON.parse(readProfileStateSnapshot(snapshot.db).json)).toEqual({
        settings: { theme: 'dark' }
      })
    } finally {
      snapshot.db.close()
    }
    expect(readdirSync(directory).filter((name) => name.startsWith('backup.db'))).toEqual([
      'backup.db'
    ])
    rmSync(directory, { recursive: true })
    expect(existsSync(directory)).toBe(false)
  })

  it.each([
    [
      'a mismatched stored hash',
      (db: ReturnType<typeof openProfileStateDatabase>['db']) => {
        db.prepare('UPDATE profile_state_documents SET content_hash = ?').run('0'.repeat(64))
      },
      'hash mismatch'
    ],
    [
      'an independently hashed invalid domain fragment',
      (db: ReturnType<typeof openProfileStateDatabase>['db']) => {
        db.prepare(
          "UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = 'settings'"
        ).run('{', hashProfileStateJson('{'))
      },
      'invalid JSON'
    ],
    [
      'an independently hashed invalid normalized history fragment',
      (db: ReturnType<typeof openProfileStateDatabase>['db']) => {
        importProfileStateJson(db, '{"automationRuns":[{"id":"run-1","output":"ok"}]}')
        db.prepare(
          'UPDATE profile_state_automation_runs SET payload = ?, content_hash = ? WHERE run_id = ?'
        ).run('{', hashProfileStateJson('{'), 'run-1')
      },
      'invalid JSON'
    ]
  ] as const)('%s', async (_description, corrupt, expectedError) => {
    const { job } = fixture()
    const primary = openProfileStateDatabase(job.databasePath, job.profileId)
    corrupt(primary.db)
    primary.db.close()
    const before = readFileSync(job.databasePath)
    const retained = `${job.targetPath}.prior`
    writeFileSync(retained, 'previous recovery point')

    await expect(runProfileStateBackupWorker(job, { workerPath })).rejects.toThrow(expectedError)
    expect(existsSync(job.targetPath)).toBe(false)
    expect(readFileSync(retained, 'utf8')).toBe('previous recovery point')
    expect(readFileSync(job.databasePath)).toEqual(before)
  })

  it.each(['true', 'false'])('waits for actual exit after an ok=%s response', async (ok) => {
    const { directory, job } = fixture()
    const delayedWorker = script(
      directory,
      `
      const { parentPort, workerData } = require('node:worker_threads')
      parentPort.postMessage({ ok: ${ok}, error: 'backup failed' })
      setTimeout(() => {
        require('node:fs').writeFileSync(workerData.targetPath, 'handles released')
        parentPort.close()
      }, 50)
    `
    )
    const result = runProfileStateBackupWorker(job, { workerPath: delayedWorker })
    await (ok === 'true' ? result : expect(result).rejects.toThrow('backup failed'))
    expect(readFileSync(job.targetPath, 'utf8')).toBe('handles released')
  })

  it.each([
    ['throw new Error("worker boot failed")', 'worker boot failed'],
    ['process.exit(0)', 'without completion'],
    ['require("node:worker_threads").parentPort.postMessage({ wrong: true })', 'Invalid profile'],
    ['setInterval(() => {}, 1000)', 'timed out']
  ])('fails closed for worker failure: %s', async (source, error) => {
    const { directory, job } = fixture()
    const failedWorker = script(directory, source)
    await expect(
      runProfileStateBackupWorker(job, { workerPath: failedWorker, timeoutMs: 500 })
    ).rejects.toThrow(error)
    expect(existsSync(job.targetPath)).toBe(false)
    rmSync(directory, { recursive: true })
  })

  it('reports a missing bundle and leaves the primary untouched', async () => {
    const { directory, job } = fixture()
    const before = readFileSync(job.databasePath)
    await expect(
      runProfileStateBackupWorker(job, { workerPath: join(directory, 'missing.js') })
    ).rejects.toThrow()
    expect(readFileSync(job.databasePath)).toEqual(before)
  })

  it('coalesces desktop work and drains a started backup before allowing quarantine', async () => {
    const { directory, job } = fixture()
    let started: () => void = () => {}
    const beginning = new Promise<void>((resolve) => {
      started = resolve
    })
    const dispatch = vi
      .spyOn(backupWorker, 'runProfileStateBackup')
      .mockImplementation((request) => {
        started()
        return runProfileStateBackupWorker(request, { workerPath })
      })
    const rotation = new ProfileStateBackupRotation(job.databasePath, job.profileId)
    rotation.schedule()
    rotation.schedule()
    await beginning
    rotation.stop()
    expect(() => rotation.assertIdle()).toThrow('Flush pending')
    await rotation.drain()
    expect(() => rotation.assertIdle()).not.toThrow()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(profileStateDatabaseBackups(job.databasePath)).toHaveLength(1)
    rmSync(directory, { recursive: true })
  })

  it('finds entries beside the launcher and above Rollup shared chunks', () => {
    expect(resolveProfileStateBackupWorkerPath(workerDirectory)).toBe(workerPath)
    expect(resolveProfileStateBackupWorkerPath(join(workerDirectory, 'chunks'))).toBe(workerPath)
  })
})
