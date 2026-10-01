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
import Database from '../../sqlite/sync-database'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import * as profileStateDocuments from './profile-state-documents'
import { profileStateJsonExportPath } from './legacy-json/profile-state-export-path'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { restoreProfileStateJsonExport } from './legacy-json/profile-state-recovery'
import {
  bootstrapProfileStateAuthority as bootstrapProfileStateAuthorityImpl,
  classifyProfileStateStorage,
  ProfileStateAuthorityBootstrapError,
  ProfileStateRecoveryRequiredError
} from './profile-state-authority-bootstrap'

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

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

const { Store } = await import('../loading-store/store')

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
  it('classifies all four storage-presence states without opening SQLite', () => {
    const directory = createDirectory()
    const { dataFile, databaseFile } = paths(directory)

    expect(classifyProfileStateStorage(dataFile, databaseFile)).toBe('neither')
    writeFileSync(dataFile, '{}')
    expect(classifyProfileStateStorage(dataFile, databaseFile)).toBe('json-only')

    const opened = openProfileStateDatabase(databaseFile, 'profile-bootstrap-test')
    opened.db.close()
    expect(classifyProfileStateStorage(dataFile, databaseFile)).toBe('both')

    rmSync(dataFile)
    expect(classifyProfileStateStorage(dataFile, databaseFile)).toBe('sqlite-only')
  })

  it('imports JSON-only state through Store export and returns the SQLite authority', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(
      options.dataFile,
      JSON.stringify({ settings: { theme: 'dark' }, futureExtension: { keep: true } })
    )

    const result = bootstrapProfileStateAuthority(options)

    expect(result.classification).toBe('json-only')
    expect(result.migrated).toBe(true)
    expect(result.authority?.readSerializedState()).toContain('futureExtension')
    expect(existsSync(options.dataFile)).toBe(true)
    expect(existsSync(profileStateJsonExportPath(options.dataFile, 1))).toBe(true)
    expect(readFileSync(profileStateJsonExportPath(options.dataFile, 1), 'utf8')).toContain(
      'futureExtension'
    )
    expect(classifyProfileStateStorage(options.dataFile, options.databaseFile)).toBe('both')

    if (result.authority === undefined) {
      throw new Error('JSON migration did not return a SQLite authority')
    }
    const store = new Store({
      dataFile: options.dataFile,
      profileStateAuthority: result.authority
    })
    expect(store.getSettings().theme).toBe('dark')

    const repeated = bootstrapProfileStateAuthority(options)
    expect(repeated.authority?.readSerializedState()).toContain('futureExtension')
  })

  it('fails closed when both files are present without a matching acceptance marker', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
    opened.db.close()

    expect(() => bootstrapProfileStateAuthority(options)).toThrowError(
      ProfileStateAuthorityBootstrapError
    )
  })

  it('rejects a legacy JSON edit after migration instead of selecting stale SQLite state', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    bootstrapProfileStateAuthority(options)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'light' } }))

    expect(() => bootstrapProfileStateAuthority(options)).toThrowError(
      ProfileStateAuthorityBootstrapError
    )
  })

  it.each([1, 2])(
    'requires explicit recovery for unreleased schema %s without changing its bytes',
    (version) => {
      const options = paths(createDirectory())
      const raw = JSON.stringify({ settings: { theme: 'dark' }, futureDomain: { retained: true } })
      const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
      profileStateDocuments.importProfileStateJson(opened.db, raw, {
        acceptedLegacyJsonHash: profileStateDocuments.hashProfileStateJson(raw)
      })
      if (version === 1) {
        opened.db.exec(
          'DROP TABLE profile_state_automation_runs; DROP TABLE profile_state_automation_runs_meta'
        )
      } else {
        opened.db.exec('DELETE FROM profile_state_automation_runs_meta')
      }
      opened.db.pragma(`user_version = ${version}`)
      opened.db.close()
      const before = readFileSync(options.databaseFile)
      for (const withJson of [false, true]) {
        if (withJson) {
          writeFileSync(options.dataFile, raw)
        }
        expect(() => bootstrapProfileStateAuthority(options)).toThrow(
          ProfileStateRecoveryRequiredError
        )
        expect(readFileSync(options.databaseFile)).toEqual(before)
      }
      const exportPath = profileStateJsonExportPath(options.dataFile, 1)
      writeFileSync(exportPath, raw)
      restoreProfileStateJsonExport({
        maintenance: acquireProfileStateMaintenance(dirname(dirname(dirname(options.dataFile)))),
        databasePath: options.databaseFile,
        dataFile: options.dataFile,
        profileId: options.profileId,
        exportPath
      })
      const recovered = bootstrapProfileStateAuthority(options)
      expect(recovered.migrated).toBe(true)
      expect(JSON.parse(recovered.authority?.readSerializedState() ?? '{}')).toMatchObject({
        futureDomain: { retained: true }
      })
    }
  )

  it('returns no authority for a brand-new profile', () => {
    const directory = createDirectory()
    const result = bootstrapProfileStateAuthority(paths(directory))

    expect(result).toEqual({ classification: 'neither', authority: undefined, migrated: false })
  })

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

  it('validates and returns an existing SQLite-only authority', () => {
    const directory = createDirectory()
    const options = paths(directory)
    const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
    opened.db.close()

    const result = bootstrapProfileStateAuthority(options)

    expect(result.classification).toBe('sqlite-only')
    expect(result.migrated).toBe(false)
    expect(result.authority?.readSerializedState()).toBeUndefined()
  })

  it('rejects malformed SQLite-only state before Store can select it', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.databaseFile, 'not sqlite')

    expect(() => bootstrapProfileStateAuthority(options)).toThrow()
  })

  it('reports retained exports when an established SQLite profile needs recovery', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const bootstrap = bootstrapProfileStateAuthority(options)
    bootstrap.authority?.close?.()
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)
    const exportPathRevision2 = profileStateJsonExportPath(options.dataFile, 2)
    const exportPathRevision10 = profileStateJsonExportPath(options.dataFile, 10)
    writeFileSync(exportPathRevision2, readFileSync(exportPath))
    writeFileSync(exportPathRevision10, readFileSync(exportPath))
    writeFileSync(
      `${options.dataFile}.sqlite-export.9007199254740992.json`,
      readFileSync(exportPath)
    )
    writeFileSync(options.databaseFile, 'not sqlite')

    try {
      bootstrapProfileStateAuthority(options)
      throw new Error('expected recovery-required startup failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileStateRecoveryRequiredError)
      if (!(error instanceof ProfileStateRecoveryRequiredError)) {
        throw error
      }
      expect(error.dataFile).toBe(options.dataFile)
      expect(error.databaseFile).toBe(options.databaseFile)
      expect(error.exportPaths).toEqual([exportPathRevision10, exportPathRevision2, exportPath])
    }
  })

  it('does not create a database when the legacy JSON cannot be imported', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, '{ malformed')

    expect(() => bootstrapProfileStateAuthority(options)).toThrow(
      'Failed to load imported profile state'
    )
    expect(existsSync(options.databaseFile)).toBe(false)
  })

  it.each([0, 1, 2, 3, 4])(
    'migrates usable legacy backup slot %s after a corrupt primary',
    (slot) => {
      const options = paths(createDirectory())
      const damaged = '{ malformed primary'
      const recovered = JSON.stringify({ settings: { theme: 'dark' }, retainedBackup: slot })
      writeFileSync(options.dataFile, damaged)
      for (let index = 0; index < slot; index += 1) {
        writeFileSync(`${options.dataFile}.bak.${index}`, '{ damaged backup')
      }
      writeFileSync(`${options.dataFile}.bak.${slot}`, recovered)

      const result = bootstrapProfileStateAuthority(options)
      expect(result.migrated).toBe(true)
      expect(JSON.parse(result.authority?.readSerializedState() ?? '{}')).toMatchObject({
        settings: { theme: 'dark' },
        retainedBackup: slot
      })
      expect(readFileSync(options.dataFile, 'utf8')).toBe(damaged)
      expect(readFileSync(`${options.dataFile}.bak.${slot}`, 'utf8')).toBe(recovered)
      expect(bootstrapProfileStateAuthority(options).migrated).toBe(false)
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

  it('refuses a pre-existing retained export before migrating JSON again', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)
    mkdirSync(exportPath)

    expect(() => bootstrapProfileStateAuthority(options)).toThrow()
    expect(existsSync(options.dataFile)).toBe(true)
    expect(existsSync(options.databaseFile)).toBe(false)

    rmSync(exportPath, { recursive: true })
    const retry = bootstrapProfileStateAuthority(options)
    expect(retry.classification).toBe('json-only')
    expect(retry.migrated).toBe(true)
    expect(retry.authority?.readSerializedState()).toContain('"dark"')
  })

  it('boots the revisioned export through the legacy Store after SQLite corruption', () => {
    const directory = createDirectory()
    const options = paths(directory)
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    bootstrapProfileStateAuthority(options)
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)

    writeFileSync(options.databaseFile, 'corrupt sqlite primary')
    writeFileSync(options.dataFile, readFileSync(exportPath))
    const rollbackStore = new Store({
      dataFile: options.dataFile,
      serializedState: readFileSync(options.dataFile, 'utf8')
    })
    expect(rollbackStore.getSettings().theme).toBe('dark')
    rollbackStore.freezeWrites()
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
    expect(readFileSync(options.dataFile)).toEqual(restoredJson)
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
    expect(readFileSync(options.databaseFile)).toEqual(databaseBytes)
    expect(readFileSync(options.dataFile)).toEqual(dataBytes)
  })
})
