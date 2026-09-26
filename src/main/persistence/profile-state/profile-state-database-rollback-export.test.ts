import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import { profileStateJsonExportPath } from './profile-state-export-path'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { restoreProfileStateJsonExport } from './profile-state-recovery'
import { openProfileStateDatabase } from './profile-state-database'
import {
  bootstrapProfileStateAuthority,
  ProfileStateAuthorityBootstrapError
} from './profile-state-authority-bootstrap'
import { restoreProfileStateDatabaseBackup } from './profile-state-database-recovery'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it('can publish an updater JSON export at a reused revision after SQLite rollback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-database-rollback-export-'))
  const directory = join(root, 'profiles', 'rollback-export')
  mkdirSync(directory, { recursive: true })
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const profileId = 'rollback-export'
  const stores: Store[] = []
  try {
    const originalAuthority = new ProfileStateSqliteAuthority(databasePath, profileId)
    const original = new Store({
      dataFile,
      profileStateAuthority: originalAuthority
    })
    stores.push(original)
    original.updateSettings({ theme: 'light' })
    await original.flushPendingOrThrowAsync()
    await originalAuthority.drainBackups()
    const backup = profileStateDatabaseBackups(databasePath)[0]
    expect(backup).toBeDefined()
    original.updateSettings({ theme: 'dark' })
    const formerRevision = original.writeLatestProfileStateJsonExport()
    expect(formerRevision).toBeTypeOf('number')
    if (!backup || formerRevision === undefined) {
      throw new Error('Missing recovery fixture')
    }
    const exportPath = profileStateJsonExportPath(dataFile, formerRevision)
    const previousExport = readFileSync(exportPath)
    original.freezeWrites()
    await original.flushAsync()

    const restored = restoreProfileStateDatabaseBackup({
      maintenance: acquireProfileStateMaintenance(root),
      databasePath,
      dataFile,
      profileId,
      backupPath: backup.path
    })
    expect(existsSync(exportPath)).toBe(false)
    expect(readFileSync(join(restored.quarantine.directory, basename(exportPath)))).toEqual(
      previousExport
    )
    const recovered = new Store({
      dataFile,
      profileStateAuthority: new ProfileStateSqliteAuthority(databasePath, profileId)
    })
    stores.push(recovered)
    recovered.updateSettings({ theme: 'system' })
    const newRevision = recovered.writeLatestProfileStateJsonExport()

    expect(newRevision).toBe(formerRevision)
    expect(JSON.parse(readFileSync(exportPath, 'utf8')).settings.theme).toBe('system')
    expect(readFileSync(exportPath)).not.toEqual(previousExport)
  } finally {
    for (const store of stores) {
      store.freezeWrites()
      await store.flushAsync()
    }
    rmSync(root, { recursive: true, force: true })
  }
})

it('leaves an explicit rollback path if compatibility publication fails before acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-store-profile-state-compat-failure-'))
  const directory = join(root, 'profiles', 'profile-authority-test')
  mkdirSync(directory, { recursive: true })
  const dataFile = join(directory, 'orca-data.json')
  const databasePath = join(directory, 'profile-state.db')
  writeFileSync(dataFile, JSON.stringify({ settings: { theme: 'light' } }), 'utf8')

  const authority = new ProfileStateSqliteAuthority(databasePath, 'profile-authority-test')
  const store = new Store({ dataFile, profileStateAuthority: authority })
  try {
    store.updateSettings({ theme: 'dark' })
    store.flushOrThrow()
    const revisionOne = store.writeLatestProfileStateJsonExport()
    expect(revisionOne).toBe(1)

    const opened = openProfileStateDatabase(databasePath, 'profile-authority-test')
    opened.db.exec(
      `CREATE TRIGGER fail_compatibility_acceptance
       BEFORE INSERT ON profile_state_meta
       WHEN NEW.key = 'legacy_json_acceptance'
       BEGIN SELECT RAISE(ABORT, 'injected compatibility failure'); END`
    )
    opened.db.close()

    store.updateSettings({ theme: 'light' })
    expect(() => store.writeLatestProfileStateJsonCompatibilityExport()).toThrow(
      'injected compatibility failure'
    )
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('light')
    expect(() =>
      bootstrapProfileStateAuthority({
        dataFile,
        databaseFile: databasePath,
        profileId: 'profile-authority-test'
      })
    ).toThrow(ProfileStateAuthorityBootstrapError)

    store.freezeWrites()
    await store.flushAsync()
    restoreProfileStateJsonExport({
      maintenance: acquireProfileStateMaintenance(root),
      databasePath,
      dataFile,
      exportPath: profileStateJsonExportPath(dataFile, revisionOne ?? 1),
      profileId: 'profile-authority-test'
    })
    expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.theme).toBe('dark')
  } finally {
    store.freezeWrites()
    await store.flushAsync()
    rmSync(root, { recursive: true, force: true })
  }
})
