import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { acquireProfileStateMaintenance } from './profile-state-access'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import { profileStateJsonExportPath } from './profile-state-export-path'
import { buildRecoveryCrashProcess, killRecoveryAt } from './profile-state-recovery-crash-process'

const suite = mkdtempSync(join(tmpdir(), 'orca-large-recovery-crash-'))
const roots: string[] = []
const profileId = 'large-recovery'
const oldJson = JSON.stringify({ opaque: 'x'.repeat(8 * 1024 * 1024), revision: 'old' })
const selectedJson = JSON.stringify({ opaque: 'y'.repeat(8 * 1024 * 1024), revision: 'selected' })
let bundle: string
beforeAll(() => {
  bundle = buildRecoveryCrashProcess(suite)
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(suite, { recursive: true, force: true }))

async function fixture() {
  const root = mkdtempSync(join(suite, 'profile-'))
  roots.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const backupPath = profileStateDatabaseBackupPath(
    databasePath,
    createProfileStateDatabaseBackupId()
  )
  const db = openProfileStateDatabase(databasePath, profileId).db
  try {
    importProfileStateJson(db, oldJson)
    importProfileStateJson(db, oldJson)
    importProfileStateJson(db, selectedJson)
    await writeProfileStateDatabaseSnapshotAsync(db, backupPath)
  } finally {
    db.close()
  }
  const options = {
    root,
    directory,
    profileId,
    databasePath,
    dataFile,
    backupPath,
    exportPath: profileStateJsonExportPath(dataFile, 3),
    markerPath: join(root, 'http1-compatibility.json'),
    kind: 'sqlite' as const
  }
  await killRecoveryAt(bundle, options, 'seed', oldJson)
  expect(existsSync(`${databasePath}-wal`)).toBe(true)
  const originalFamily = new Map(
    ['', '-wal', '-shm'].map((suffix) => [suffix, readFileSync(databasePath + suffix)])
  )
  return { ...options, originalFamily, backupBytes: readFileSync(backupPath) }
}

function snapshot(path: string) {
  const db = openProfileStateDatabaseReadOnly(path, profileId).db
  try {
    const { json, revision } = readProfileStateSnapshot(db)
    return { json, revision }
  } finally {
    db.close()
  }
}

const boundaries = [
  ...(process.platform === 'darwin'
    ? ['clone:1:before', 'clone:1:after', 'clone:2:after', 'clone:3:after']
    : []),
  'primary',
  'sqlite-publish:before',
  'sqlite-publish:after'
]

describe('large independent recovery copies under process death', () => {
  it.each(boundaries)(
    'preserves exact backup and retry state after %s',
    async (boundary) => {
      const profile = await fixture()
      const stage = boundary === 'primary' ? `removed:${profile.databasePath}` : boundary
      await killRecoveryAt(bundle, profile, stage)
      expect(readFileSync(profile.backupPath).equals(profile.backupBytes)).toBe(true)
      if (boundary.startsWith('clone:')) {
        for (const [suffix, bytes] of profile.originalFamily) {
          expect(readFileSync(profile.databasePath + suffix).equals(bytes)).toBe(true)
        }
      } else {
        const directory = readdirSync(profile.directory).find((name) =>
          name.startsWith('profile-state-corrupt-')
        )
        if (directory === undefined) {
          throw new Error('Recovery did not preserve a quarantine')
        }
        for (const [suffix, bytes] of profile.originalFamily) {
          expect(
            readFileSync(join(profile.directory, directory, `profile-state.db${suffix}`)).equals(
              bytes
            )
          ).toBe(true)
        }
        expect(
          readFileSync(join(profile.directory, directory, basename(profile.backupPath))).equals(
            profile.backupBytes
          )
        ).toBe(true)
        if (boundary === 'sqlite-publish:after') {
          expect(snapshot(profile.databasePath)).toEqual({ json: selectedJson, revision: 3 })
        } else {
          expect(existsSync(profile.databasePath)).toBe(false)
        }
      }
      const maintenance = acquireProfileStateMaintenance(profile.root)
      try {
        restoreProfileStateDatabaseBackup({ ...profile, maintenance })
      } finally {
        maintenance.release()
      }
      expect(snapshot(profile.databasePath)).toEqual({ json: selectedJson, revision: 3 })
      expect(readFileSync(profile.backupPath).equals(profile.backupBytes)).toBe(true)
    },
    30_000
  )
})
