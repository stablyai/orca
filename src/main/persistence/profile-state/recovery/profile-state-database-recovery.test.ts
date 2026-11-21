import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableFileWrite from '../../../filesystem/durable-file-write'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../database/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../documents/profile-state-documents'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from '../backup/profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from '../database/profile-state-database-snapshot'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'
import { acquireProfileStateMaintenance } from '../access/profile-state-access'
import { profileStateJsonExportPath } from '../legacy-json/profile-state-export-path'
import {
  ensureProfileStateAuthorityMarker,
  hasProfileStateAuthorityMarker
} from '../database/profile-state-authority-marker'

const directories: string[] = []
const profileId = 'profile-recovery-test'
const savedJson = JSON.stringify({
  settings: { theme: 'dark', httpProxyUrl: 'safe-storage-sealed-ciphertext' },
  ui: { unknownField: { keep: true } },
  opaqueExtension: { sequence: 71 }
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

async function fixture(options: { profileId?: string; empty?: boolean; json?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-database-recovery-'))
  directories.push(root)
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  const maintenance = acquireProfileStateMaintenance(root)
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const exportPath = profileStateJsonExportPath(dataFile, 1)
  const backupPath = profileStateDatabaseBackupPath(
    databasePath,
    createProfileStateDatabaseBackupId()
  )
  const source = openProfileStateDatabase(
    join(directory, 'source.db'),
    options.profileId ?? profileId
  )
  try {
    if (!options.empty) {
      importProfileStateJson(source.db, options.json ?? savedJson)
    }
    await writeProfileStateDatabaseSnapshotAsync(source.db, backupPath)
  } finally {
    source.db.close()
  }
  writeFileSync(dataFile, '{"settings":{"theme":"stale"}}')
  writeFileSync(exportPath, '{"settings":{"theme":"migration"}}')
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    writeFileSync(`${databasePath}${suffix}`, `damaged ${suffix || 'primary'}`)
  }
  ensureProfileStateAuthorityMarker(databasePath)
  return { databasePath, dataFile, backupPath, exportPath, profileId, maintenance }
}

function readRestored(databasePath: string): string {
  const opened = openProfileStateDatabaseReadOnly(databasePath, profileId)
  try {
    return exportProfileStateJson(opened.db)
  } finally {
    opened.db.close()
  }
}

describe('profile state database backup recovery', () => {
  it('preserves recoverable evidence when publication fails after removing a damaged family', async () => {
    const options = await fixture()
    const renameDurableSync = durableFileWrite.renameDurableSync
    vi.spyOn(durableFileWrite, 'renameDurableSync').mockImplementation((source, target) => {
      if (target === options.databasePath) {
        throw new Error('injected snapshot publication failure')
      }
      return renameDurableSync(source, target)
    })
    expect(() => restoreProfileStateDatabaseBackup(options)).toThrow(
      'injected snapshot publication failure'
    )
    expect(existsSync(options.databasePath)).toBe(false)
    expect(hasProfileStateAuthorityMarker(options.databasePath)).toBe(true)
    expect(existsSync(options.backupPath)).toBe(true)
    const archives = readdirSync(dirname(options.databasePath)).filter((name) =>
      name.startsWith('profile-state-corrupt-')
    )
    expect(archives).toHaveLength(1)
    expect(
      readFileSync(join(dirname(options.databasePath), archives[0], 'profile-state.db-wal'), 'utf8')
    ).toBe('damaged -wal')
    vi.restoreAllMocks()
    options.maintenance.release()
    options.maintenance = acquireProfileStateMaintenance(
      dirname(dirname(dirname(options.dataFile)))
    )
    restoreProfileStateDatabaseBackup(options)
    expect(readRestored(options.databasePath)).toBe(savedJson)
  })
})
