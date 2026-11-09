import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import { profileStateJsonExportPath } from './legacy-json/profile-state-export-path'
import { acquireProfileStateMaintenance } from './profile-state-access'
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
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it('can publish an explicit JSON export at a reused revision after SQLite rollback', async () => {
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
