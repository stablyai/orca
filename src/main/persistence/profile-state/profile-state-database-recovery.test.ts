import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import * as durableFileWrite from '../../durable-file-write'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import { exportProfileStateJson, importProfileStateJson } from './profile-state-documents'
import {
  createProfileStateDatabaseBackupId,
  profileStateDatabaseBackupPath
} from './profile-state-backup-path'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'
import { restoreProfileStateJsonExport } from './legacy-json/profile-state-recovery'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { profileStateJsonExportPath } from './legacy-json/profile-state-export-path'
import {
  ensureProfileStateAuthorityMarker,
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from './profile-state-authority-marker'

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

function expectOriginals(options: Awaited<ReturnType<typeof fixture>>): void {
  expect(readFileSync(options.databasePath, 'utf8')).toBe('damaged primary')
  expect(readFileSync(options.dataFile, 'utf8')).toContain('stale')
  expect(existsSync(options.backupPath)).toBe(true)
  expect(readdirSync(dirname(options.databasePath)).some((name) => name.endsWith('.tmp'))).toBe(
    false
  )
}

describe('profile state database backup recovery', () => {
  it('rejects corruption in a large cloned staging file before changing recovery state', async () => {
    const options = await fixture({
      json: JSON.stringify({ opaqueExtension: 'x'.repeat(8 * 1024 * 1024) })
    })
    const backup = new Database(options.backupPath)
    try {
      backup.exec("UPDATE profile_state_documents SET content_hash = printf('%064d', 0)")
    } finally {
      backup.close()
    }
    const originalBackup = readFileSync(options.backupPath)
    expect(() => restoreProfileStateDatabaseBackup(options)).toThrow()
    expectOriginals(options)
    expect(readFileSync(options.backupPath).equals(originalBackup)).toBe(true)
    expect(
      readdirSync(dirname(options.databasePath)).some((name) =>
        name.startsWith('.orca-recovery-clone-')
      )
    ).toBe(false)
  })

  it.each([true, false])(
    'restores SQLite authority with the old database present=%s',
    async (hasDatabase) => {
      const options = await fixture()
      const backupBytes = readFileSync(options.backupPath)
      if (!hasDatabase) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          rmSync(`${options.databasePath}${suffix}`)
        }
      }
      const beforeRestore = vi.fn()

      const result = restoreProfileStateDatabaseBackup({ ...options, beforeRestore })

      expect(result.revision).toBe(1)
      expect(hasProfileStateAuthorityMarker(options.databasePath)).toBe(true)
      expect(
        readFileSync(
          join(
            result.quarantine.directory,
            basename(profileStateAuthorityMarkerPath(options.databasePath))
          ),
          'utf8'
        )
      ).toBe('sqlite\n')
      expect(beforeRestore).toHaveBeenCalledOnce()
      expect(readRestored(options.databasePath)).toBe(savedJson)
      expect(existsSync(options.dataFile)).toBe(false)
      expect(readFileSync(options.backupPath)).toEqual(backupBytes)
      expect(existsSync(options.exportPath)).toBe(false)
      expect(readFileSync(join(result.quarantine.directory, basename(options.backupPath)))).toEqual(
        backupBytes
      )
      expect(
        readFileSync(join(result.quarantine.directory, basename(options.dataFile)), 'utf8')
      ).toContain('stale')
      expect(existsSync(join(result.quarantine.directory, basename(options.exportPath)))).toBe(true)
      if (hasDatabase) {
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          expect(
            readFileSync(join(result.quarantine.directory, `profile-state.db${suffix}`), 'utf8')
          ).toBe(`damaged ${suffix || 'primary'}`)
        }
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(existsSync(`${options.databasePath}${suffix}`)).toBe(false)
      }
    }
  )

  it.each(['foreign identity', 'empty profile'])(
    'rejects a %s backup before touching recovery state',
    async (kind) => {
      const options = await fixture(
        kind === 'foreign identity' ? { profileId: 'other-profile' } : { empty: true }
      )
      const beforeRestore = vi.fn()
      expect(() => restoreProfileStateDatabaseBackup({ ...options, beforeRestore })).toThrow()
      expect(beforeRestore).not.toHaveBeenCalled()
      expectOriginals(options)
    }
  )

  it.each(['corrupt hash', 'future schema', 'WAL mode'])(
    'rejects a backup with %s',
    async (kind) => {
      const options = await fixture()
      const backup = new Database(options.backupPath)
      try {
        if (kind === 'corrupt hash') {
          backup.exec("UPDATE profile_state_documents SET payload = '{}' WHERE domain = 'settings'")
        }
        if (kind === 'future schema') {
          backup.pragma('user_version = 999')
        }
        if (kind === 'WAL mode') {
          backup.pragma('journal_mode = WAL')
        }
      } finally {
        backup.close()
      }
      const beforeRestore = vi.fn()
      expect(() => restoreProfileStateDatabaseBackup({ ...options, beforeRestore })).toThrow()
      expect(beforeRestore).not.toHaveBeenCalled()
      expectOriginals(options)
    }
  )

  it.each(['-wal', '-shm', '-journal'])(
    'rejects a selected backup with a %s sidecar',
    async (suffix) => {
      const options = await fixture()
      writeFileSync(`${options.backupPath}${suffix}`, 'external writer evidence')
      expect(() => restoreProfileStateDatabaseBackup(options)).toThrow('not self-contained')
      expectOriginals(options)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a reserved-name symlink to a valid snapshot',
    async () => {
      const options = await fixture()
      const alias = profileStateDatabaseBackupPath(
        options.databasePath,
        createProfileStateDatabaseBackupId()
      )
      symlinkSync(options.backupPath, alias)
      expect(() => restoreProfileStateDatabaseBackup({ ...options, backupPath: alias })).toThrow(
        'regular file'
      )
      expectOriginals(options)
    }
  )

  it('refuses a backup path outside the retained profile inventory', async () => {
    const options = await fixture()
    expect(() =>
      restoreProfileStateDatabaseBackup({ ...options, backupPath: options.databasePath })
    ).toThrow('not retained')
    expectOriginals(options)
  })

  it('keeps live state untouched when an older artifact cannot be archived', async () => {
    const options = await fixture()
    mkdirSync(profileStateJsonExportPath(options.dataFile, 2))
    expect(() => restoreProfileStateDatabaseBackup(options)).toThrow()
    expectOriginals(options)
  })

  it('keeps live state untouched when the pre-restore cache invalidation fails', async () => {
    const options = await fixture()
    expect(() =>
      restoreProfileStateDatabaseBackup({
        ...options,
        beforeRestore: () => {
          throw new Error('injected pre-restore failure')
        }
      })
    ).toThrow('injected pre-restore failure')
    expectOriginals(options)
  })

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

  it('archives and removes SQLite backups and sidecars when explicitly rolling back to JSON', async () => {
    const options = await fixture()
    writeFileSync(`${options.backupPath}-journal`, 'backup recovery evidence')
    const recovered = restoreProfileStateJsonExport(options)
    expect(hasProfileStateAuthorityMarker(options.databasePath)).toBe(false)
    expect(
      readFileSync(
        join(
          recovered.quarantine.directory,
          basename(profileStateAuthorityMarkerPath(options.databasePath))
        ),
        'utf8'
      )
    ).toBe('sqlite\n')
    expect(existsSync(options.databasePath)).toBe(false)
    expect(existsSync(options.backupPath)).toBe(false)
    expect(existsSync(`${options.backupPath}-journal`)).toBe(false)
    expect(
      readFileSync(
        join(recovered.quarantine.directory, `${basename(options.backupPath)}-journal`),
        'utf8'
      )
    ).toBe('backup recovery evidence')
    expect(readFileSync(options.dataFile, 'utf8')).toContain('migration')
  })
})
