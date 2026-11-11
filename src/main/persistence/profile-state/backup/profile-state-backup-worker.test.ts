import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../database/profile-state-database'
import {
  importProfileStateJson,
  readProfileStateSnapshot
} from '../documents/profile-state-documents'
import { hashProfileStatePayload as hashProfileStateJson } from '../documents/profile-state-document-validation'
import { runProfileStateBackupWorker } from './profile-state-backup-worker'

const directories: string[] = []
let workerDirectory: string
let workerPath: string

beforeAll(async () => {
  workerDirectory = mkdtempSync(join(tmpdir(), 'orca-backup-worker-entry-'))
  workerPath = join(workerDirectory, 'profile-state-backup-worker-entry.js')
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/backup/profile-state-backup-worker-entry.ts')
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
    expect(readFileSync(job.databasePath).equals(before)).toBe(true)
  })
})
