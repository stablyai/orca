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
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import '../database/profile-state-database'
import { profileStateDatabaseFile } from '../../../../shared/profile-state-storage-paths'
import * as profileStateDocuments from '../documents/profile-state-documents'
import '../documents/profile-state-document-validation'
import { profileStateJsonExportPath } from '../legacy-json/profile-state-export-path'
import { acquireProfileStateMaintenance } from '../access/profile-state-access'
import { restoreProfileStateJsonExport } from '../legacy-json/profile-state-recovery'
import { bootstrapProfileStateAuthority as bootstrapProfileStateAuthorityImpl } from './profile-state-authority-bootstrap'
import { classifyProfileStateStorage } from '../database/profile-state-storage-classification'
import { ProfileStateAuthorityBootstrapError } from '../recovery/profile-state-recovery-required'

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
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

const { Store } = await import('../../loading-store/store')

const temporaryDirectories: string[] = []
const authoritiesToClose: NonNullable<
  ReturnType<typeof bootstrapProfileStateAuthorityImpl>['authority']
>[] = []

function bootstrapProfileStateAuthority(
  options: Parameters<typeof bootstrapProfileStateAuthorityImpl>[0]
): ReturnType<typeof bootstrapProfileStateAuthorityImpl> {
  const result = bootstrapProfileStateAuthorityImpl(options)
  if (result.authority !== undefined) {
    authoritiesToClose.push(result.authority)
  }
  return result
}

afterEach(() => {
  for (const authority of authoritiesToClose.splice(0)) {
    authority.close?.()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function createDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-profile-state-bootstrap-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'profiles', 'profile-bootstrap-test')
  mkdirSync(directory, { recursive: true })
  return directory
}

function paths(directory: string): {
  dataFile: string
  databaseFile: string
  profileId: string
} {
  return {
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: profileStateDatabaseFile(directory),
    profileId: 'profile-bootstrap-test'
  }
}

describe('profile state authority bootstrap', () => {
  it('cleans failed empty-profile initialization before a successful retry', () => {
    const directory = createDirectory()
    const options = { ...paths(directory), allowEmptyProfileState: true }
    const initializationFailure = new Error('injected initial schema failure')
    const originalExec = Database.prototype.exec
    const execSpy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database,
      sql
    ) {
      originalExec.call(this, sql)
      if (sql.includes('CREATE TABLE')) {
        const row = this.prepare('PRAGMA database_list').get()
        if (typeof row?.file !== 'string') {
          throw new Error('Expected a file-backed database during initialization')
        }
        expect(existsSync(`${row.file}-journal`)).toBe(true)
        for (const suffix of ['-wal', '-shm']) {
          writeFileSync(`${row.file}${suffix}`, 'interrupted schema initialization')
        }
        throw initializationFailure
      }
    })

    expect(() => bootstrapProfileStateAuthority(options)).toThrowError(
      expect.objectContaining({ cause: initializationFailure })
    )
    expect(existsSync(options.databaseFile)).toBe(false)
    expect(classifyProfileStateStorage(options.dataFile, options.databaseFile)).toBe('neither')
    expect(readdirSync(directory)).toEqual([])

    execSpy.mockRestore()
    const retry = bootstrapProfileStateAuthority(options)
    expect(retry.migrated).toBe(false)
    expect(retry.authority).toBeDefined()
    expect(retry.authority?.readSerializedState()).toBeUndefined()
    expect(bootstrapProfileStateAuthority(options).classification).toBe('sqlite-only')
  })

  it('preserves JSON created while an empty database is being initialized', () => {
    const options = { ...paths(createDirectory()), allowEmptyProfileState: true }
    const source = '{"settings":{"theme":"dark"}}'
    const originalClose = Database.prototype.close
    vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database) {
      originalClose.call(this)
      writeFileSync(options.dataFile, source)
    })

    expect(() => bootstrapProfileStateAuthority(options)).toThrow(
      'Profile state storage changed while creating an empty database'
    )
    expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
    expect(readdirSync(dirname(options.dataFile))).toEqual(['orca-data.json'])
  })

  it.each(['legacy-backup', 'sqlite-export'])(
    'preserves a %s created while an empty database is being initialized',
    (artifact) => {
      const options = { ...paths(createDirectory()), allowEmptyProfileState: true }
      const path =
        artifact === 'legacy-backup'
          ? `${options.dataFile}.bak.0`
          : profileStateJsonExportPath(options.dataFile, 1)
      const source = '{"settings":{"theme":"dark"}}'
      const originalClose = Database.prototype.close
      vi.spyOn(Database.prototype, 'close').mockImplementationOnce(function (this: Database) {
        originalClose.call(this)
        writeFileSync(path, source)
      })

      expect(() => bootstrapProfileStateAuthority(options)).toThrow()
      expect(existsSync(options.databaseFile)).toBe(false)
      expect(existsSync(options.dataFile)).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(source)
      expect(readdirSync(dirname(path))).toEqual([basename(path)])
    }
  )

  it.each(['-wal', '-shm', '-journal'])(
    'treats an orphaned SQLite %s sidecar as authority evidence with or without JSON',
    (suffix) => {
      const options = paths(createDirectory())
      const sidecar = `${options.databaseFile}${suffix}`
      writeFileSync(sidecar, 'orphaned recovery evidence')

      expect(classifyProfileStateStorage(options.dataFile, options.databaseFile)).toBe(
        'sqlite-only'
      )
      expect(() => bootstrapProfileStateAuthority(options)).toThrow()
      writeFileSync(options.dataFile, '{"settings":{"theme":"dark"}}')
      expect(classifyProfileStateStorage(options.dataFile, options.databaseFile)).toBe('both')
      expect(() => bootstrapProfileStateAuthority(options)).toThrow()
      expect(existsSync(options.databaseFile)).toBe(false)
      expect(readFileSync(sidecar, 'utf8')).toBe('orphaned recovery evidence')
      expect(readFileSync(options.dataFile, 'utf8')).toBe('{"settings":{"theme":"dark"}}')
    }
  )

  it('preserves every source when legacy primary and backups are unusable', () => {
    const options = paths(createDirectory())
    writeFileSync(options.dataFile, '{ malformed primary')
    writeFileSync(`${options.dataFile}.bak.0`, '{ malformed backup')
    expect(() => bootstrapProfileStateAuthority(options)).toThrow(
      ProfileStateAuthorityBootstrapError
    )
    expect(readFileSync(options.dataFile, 'utf8')).toBe('{ malformed primary')
    expect(readFileSync(`${options.dataFile}.bak.0`, 'utf8')).toBe('{ malformed backup')
    expect(existsSync(options.databaseFile)).toBe(false)
  })

  it('cleans a temporary database when import fails after opening SQLite', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const importFailure = new Error('injected import failure')
    const importSpy = vi
      .spyOn(profileStateDocuments, 'importProfileStateJson')
      .mockImplementation(() => {
        throw importFailure
      })

    expect(() => bootstrapProfileStateAuthority(options)).toThrow(importFailure)
    expect(classifyProfileStateStorage(options.dataFile, options.databaseFile)).toBe('json-only')
    expect(existsSync(options.databaseFile)).toBe(false)
    expect(
      readdirSync(directory).some((name) => name.includes('.migration.') && name.endsWith('.tmp'))
    ).toBe(false)

    importSpy.mockRestore()
    const retry = bootstrapProfileStateAuthority(options)
    expect(retry.migrated).toBe(true)
    expect(retry.authority?.readSerializedState()).toContain('"dark"')
  })

  it('quarantines SQLite and restores a selected export for legacy rollback', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const bootstrap = bootstrapProfileStateAuthority(options)
    bootstrap.authority?.close?.()
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)
    writeFileSync(options.databaseFile, 'corrupt sqlite primary')
    writeFileSync(`${options.databaseFile}-wal`, 'corrupt wal sidecar')
    const restoredJson = readFileSync(exportPath)

    const result = restoreProfileStateJsonExport({
      maintenance: acquireProfileStateMaintenance(dirname(dirname(dirname(options.dataFile)))),
      databasePath: options.databaseFile,
      dataFile: options.dataFile,
      profileId: options.profileId,
      exportPath,
      quarantineRoot: join(directory, 'quarantine')
    })

    expect(result.removedDatabaseFiles).toEqual(
      expect.arrayContaining([options.databaseFile, `${options.databaseFile}-wal`])
    )
    expect(existsSync(options.databaseFile)).toBe(false)
    expect(readFileSync(options.dataFile).equals(restoredJson)).toBe(true)
    expect(existsSync(exportPath)).toBe(false)
    expect(readFileSync(join(result.quarantine.directory, 'profile-state.db'), 'utf8')).toBe(
      'corrupt sqlite primary'
    )
    expect(readFileSync(join(result.quarantine.directory, 'profile-state.db-wal'), 'utf8')).toBe(
      'corrupt wal sidecar'
    )

    const rollbackStore = new Store({
      dataFile: options.dataFile,
      serializedState: readFileSync(options.dataFile, 'utf8')
    })
    expect(rollbackStore.getSettings().theme).toBe('dark')
    rollbackStore.freezeWrites()
  })

  it('validates the selected export before quarantining or replacing anything', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    bootstrapProfileStateAuthority(options)
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)
    writeFileSync(exportPath, '{ malformed')
    const databaseBytes = readFileSync(options.databaseFile)
    const dataBytes = readFileSync(options.dataFile)

    expect(() =>
      restoreProfileStateJsonExport({
        maintenance: acquireProfileStateMaintenance(dirname(dirname(dirname(options.dataFile)))),
        databasePath: options.databaseFile,
        dataFile: options.dataFile,
        profileId: options.profileId,
        exportPath
      })
    ).toThrow('Profile state JSON is invalid')
    expect(readFileSync(options.databaseFile).equals(databaseBytes)).toBe(true)
    expect(readFileSync(options.dataFile).equals(dataBytes)).toBe(true)
  })
})
