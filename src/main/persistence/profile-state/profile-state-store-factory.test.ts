import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isProfileStateSqliteAvailable,
  openProfileStateDatabase,
  profileStateDatabaseFile
} from './profile-state-database'
import {
  createProfileStateStore as createProfileStateStoreImpl,
  type ProfileStateStoreFactoryOptions
} from './profile-state-store-factory'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './profile-state-export-path'
import { ProfileStateRecoveryRequiredError } from './profile-state-authority-bootstrap'
import { acquireProfileStateMaintenance } from './profile-state-access'
import { restoreProfileStateJsonExport } from './profile-state-recovery'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { LoadedStateParsingOperations } from '../loading-store/loaded-state-parsing'
import { hashProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { PROFILE_STATE_DATABASE_SCHEMA_VERSION } from './profile-state-database-schema'

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

vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const temporaryDirectories: string[] = []
const storesToClose: ReturnType<typeof createProfileStateStoreImpl>['store'][] = []

function createProfileStateStore(
  options: ProfileStateStoreFactoryOptions
): ReturnType<typeof createProfileStateStoreImpl> {
  const result = createProfileStateStoreImpl(options)
  storesToClose.push(result.store)
  return result
}

afterEach(async () => {
  vi.restoreAllMocks()
  const openedStores = storesToClose.splice(0)
  for (const store of openedStores) {
    store.freezeWrites()
  }
  for (const store of openedStores) {
    await store.flushAsync()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createOptions(): ProfileStateStoreFactoryOptions & { directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-profile-state-store-factory-'))
  temporaryDirectories.push(root)
  const directory = join(root, 'profiles', 'profile-factory-test')
  mkdirSync(directory, { recursive: true })
  return {
    directory,
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: profileStateDatabaseFile(directory),
    profileId: 'profile-factory-test'
  }
}

describe('profile state Store authority factory', () => {
  it.each([false, true])(
    'refuses future schemas without changing storage (retained JSON=%s)',
    (keepJson) => {
      const options = createOptions()
      const source = '{"settings":{"theme":"dark"},"futureDomain":{"keep":true}}'
      const { db } = openProfileStateDatabase(options.databaseFile, options.profileId)
      try {
        importProfileStateJson(db, source, { acceptedLegacyJsonHash: hashProfileStateJson(source) })
        db.pragma(`user_version = ${PROFILE_STATE_DATABASE_SCHEMA_VERSION + 1}`)
      } finally {
        db.close()
      }
      if (keepJson) {
        writeFileSync(options.dataFile, source)
      }
      const databaseBefore = readFileSync(options.databaseFile)

      expect(() =>
        createProfileStateStore({ ...options, authorityMode: 'sqlite-established' })
      ).toThrow(ProfileStateRecoveryRequiredError)
      expect(readFileSync(options.databaseFile)).toEqual(databaseBefore)
      expect(existsSync(options.dataFile)).toBe(keepJson)
      if (keepJson) {
        expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
      }
    }
  )

  it('closes a migrated authority when Store normalization fails', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, '{"settings":{"theme":"dark"}}')
    const close = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'close')
    const readInitialState = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'readInitialState')
    vi.spyOn(LoadedStateParsingOperations.prototype, 'loadParsedFromAuthority').mockImplementation(
      () => {
        throw new Error('injected normalization failure')
      }
    )

    expect(() =>
      createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    ).toThrow('injected normalization failure')
    expect(close).toHaveBeenCalledOnce()
    expect(readInitialState).toHaveBeenCalledOnce()
    const initial = readInitialState.mock.results[0]
    if (initial?.type !== 'return') {
      throw new Error('Expected a startup token before normalization')
    }
    expect(() => initial.value.takeParsedState?.()).toThrow('already been consumed')
  })

  it('uses a capability probe that remains false on a Node 18-style host', () => {
    const original = process.getBuiltinModule
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) => {
      if (id === 'node:sqlite') {
        return undefined
      }
      return original(id)
    })

    expect(isProfileStateSqliteAvailable()).toBe(false)
  })

  it('keeps legacy construction read/write-compatible and does not create SQLite', () => {
    const options = createOptions()
    const source = JSON.stringify({ settings: { theme: 'dark' }, unknownDomain: { keep: true } })
    writeFileSync(options.dataFile, source)

    const result = createProfileStateStore(options)

    expect(result.backend).toBe('json')
    expect(result.classification).toBe('json-only')
    expect(result.migrated).toBe(false)
    expect(result.store.getSettings().theme).toBe('dark')
    expect(existsSync(options.databaseFile)).toBe(false)
    expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
  })

  it.each([0, 1, 2, 3, 4])(
    'requires selected recovery when only legacy backup slot %s remains',
    (slot) => {
      const options = createOptions()
      const backup = `${options.dataFile}.bak.${slot}`
      const source = '{"settings":{"theme":"dark"},"futureDomain":{"preserved":true}}'
      writeFileSync(backup, source)

      expect(() =>
        createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
      ).toThrow('restore a selected backup')
      expect(existsSync(options.databaseFile)).toBe(false)
      expect(existsSync(options.dataFile)).toBe(false)
      expect(readFileSync(backup, 'utf8')).toBe(source)

      restoreProfileStateJsonExport({
        maintenance: acquireProfileStateMaintenance(dirname(dirname(options.directory))),
        databasePath: options.databaseFile,
        dataFile: options.dataFile,
        profileId: options.profileId,
        exportPath: backup
      })
      const recovered = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
      expect(recovered.backend).toBe('sqlite')
      expect(JSON.parse(recovered.store.prepareProfileStateExport().json)).toMatchObject({
        settings: { theme: 'dark' },
        futureDomain: { preserved: true }
      })
      expect(readFileSync(backup, 'utf8')).toBe(source)
    }
  )

  it.each(['legacy', 'sqlite-established'] as const)(
    'preserves admitted %s recovery from a missing JSON primary',
    (authorityMode) => {
      const options = createOptions()
      const source = '{"settings":{"theme":"dark"}}'
      writeFileSync(`${options.dataFile}.bak.0`, source)

      const recovered = createProfileStateStore({ ...options, authorityMode })
      expect(recovered.backend).toBe('json')
      expect(recovered.store.getSettings().theme).toBe('dark')
      expect(existsSync(options.databaseFile)).toBe(false)
      expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
    }
  )

  it('uses one explicit candidate policy to migrate JSON and construct a SQLite Store', () => {
    const options = createOptions()
    const source = JSON.stringify({ settings: { theme: 'dark' }, unknownDomain: { keep: true } })
    writeFileSync(options.dataFile, source)

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    expect(result.backend).toBe('sqlite')
    expect(result.classification).toBe('json-only')
    expect(result.migrated).toBe(true)
    expect(result.store.getSettings().theme).toBe('dark')
    expect(existsSync(options.databaseFile)).toBe(true)
    expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
  })

  it('keeps an unmigrated JSON profile on the legacy path in established mode', () => {
    const options = createOptions()
    const source = JSON.stringify({ settings: { theme: 'dark' } })
    writeFileSync(options.dataFile, source)

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-established' })

    expect(result.backend).toBe('json')
    expect(result.classification).toBe('json-only')
    expect(result.migrated).toBe(false)
    expect(existsSync(options.databaseFile)).toBe(false)
    expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
  })

  it('reuses the candidate authority after the legacy export is removed', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    rmSync(options.dataFile)

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    expect(result.backend).toBe('sqlite')
    expect(result.classification).toBe('sqlite-only')
    expect(result.migrated).toBe(false)
    expect(result.store.getSettings().theme).toBe('dark')
  })

  it('reopens an established SQLite profile without the migration switch', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    rmSync(options.dataFile)

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-established' })

    expect(result.backend).toBe('sqlite')
    expect(result.classification).toBe('sqlite-only')
    expect(result.migrated).toBe(false)
    expect(result.store.getSettings().theme).toBe('dark')
  })

  it('fails closed instead of falling back to a stale JSON mirror when SQLite is missing', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const migrated = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)
    expect(existsSync(exportPath)).toBe(true)
    migrated.store.freezeWrites()
    rmSync(options.databaseFile)

    expect(() =>
      createProfileStateStore({ ...options, authorityMode: 'sqlite-established' })
    ).toThrow(ProfileStateRecoveryRequiredError)
  })

  it('does not let candidate mode re-import JSON after SQLite was established', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const migrated = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    migrated.store.freezeWrites()
    rmSync(options.databaseFile)

    expect(() =>
      createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    ).toThrow(ProfileStateRecoveryRequiredError)
  })

  it('reopens JSON after an explicit rollback removes the SQLite export marker', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    const migrated = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    const exportPath = profileStateJsonExportPath(options.dataFile, 1)
    migrated.store.freezeWrites()

    restoreProfileStateJsonExport({
      maintenance: acquireProfileStateMaintenance(dirname(dirname(options.directory))),
      databasePath: options.databaseFile,
      dataFile: options.dataFile,
      exportPath,
      profileId: options.profileId
    })

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-established' })
    expect(result.backend).toBe('json')
    expect(result.store.getSettings().theme).toBe('dark')
  })

  it('keeps a migrated profile on SQLite across mutation and restart', () => {
    const options = createOptions()
    const source = JSON.stringify({
      settings: { theme: 'light' },
      unknownDomain: { preserved: true }
    })
    writeFileSync(options.dataFile, source)
    const first = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    first.store.updateSettings({ theme: 'dark' })
    first.store.flushOrThrow()

    expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
    rmSync(options.dataFile)
    const restarted = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    expect(restarted.store.getSettings().theme).toBe('dark')
    expect(JSON.parse(restarted.store.prepareProfileStateExport().json)).toMatchObject({
      settings: { theme: 'dark' },
      unknownDomain: { preserved: true }
    })
  })

  it('initializes a valid empty SQLite profile instead of falling back to legacy JSON', () => {
    const options = createOptions()
    const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
    opened.db.close()

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    expect(result.backend).toBe('sqlite')
    expect(result.classification).toBe('sqlite-only')
    expect(result.store.getSettings()).toBeDefined()
    result.store.updateSettings({ theme: 'dark' })
    result.store.flushOrThrow()

    const verifier = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    expect(verifier.store.getSettings().theme).toBe('dark')
  })

  it('establishes SQLite for a fresh candidate profile before its first write', () => {
    const options = createOptions()

    const result = createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    expect(result.backend).toBe('sqlite')
    expect(result.classification).toBe('neither')
    expect(result.migrated).toBe(false)
    expect(existsSync(options.databaseFile)).toBe(true)
    result.store.updateSettings({ theme: 'dark' })
    result.store.flushOrThrow()
    result.store.freezeWrites()

    const restarted = createProfileStateStore({ ...options, authorityMode: 'sqlite-established' })
    expect(restarted.backend).toBe('sqlite')
    expect(restarted.store.getSettings().theme).toBe('dark')
    restarted.store.freezeWrites()
  })

  it('does not let legacy construction silently edit a SQLite profile', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    rmSync(options.dataFile)

    expect(() => createProfileStateStore(options)).toThrowError(
      expect.objectContaining({
        code: 'profile-state-authority-required'
      })
    )
  })

  it('refuses a stale JSON mirror when candidate mode sees both files', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'light' } }))

    expect(() =>
      createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })
    ).toThrow('matching acceptance marker')
  })

  it('fails closed for the Node 18 legacy path when migration leaves both authorities', () => {
    const options = createOptions()
    writeFileSync(options.dataFile, JSON.stringify({ settings: { theme: 'dark' } }))
    createProfileStateStore({ ...options, authorityMode: 'sqlite-candidate' })

    expect(() => createProfileStateStore(options)).toThrowError(
      expect.objectContaining({
        code: 'profile-state-authority-required'
      })
    )
  })

  describe.each(['legacy', 'sqlite-established', 'sqlite-candidate'] as const)(
    '%s missing database recovery',
    (authorityMode) => {
      it.each([
        { hasJson: true, artifact: 'export' },
        { hasJson: false, artifact: 'export' },
        { hasJson: true, artifact: 'backup' },
        { hasJson: false, artifact: 'backup' }
      ])(
        'fails closed with a retained $artifact and JSON present=$hasJson',
        ({ hasJson, artifact }) => {
          const options = createOptions()
          const source = JSON.stringify({ settings: { theme: 'dark' } })
          writeFileSync(options.dataFile, source)
          const migrated = createProfileStateStore({
            ...options,
            authorityMode: 'sqlite-candidate'
          })
          migrated.store.freezeWrites()
          rmSync(options.databaseFile)
          if (artifact === 'backup') {
            for (const path of profileStateJsonExportPaths(options.dataFile)) {
              rmSync(path)
            }
            writeFileSync(
              `${options.databaseFile}.backup.1789999999999-00000000-0000-4000-8000-000000000000.db`,
              'reserved recovery artifact'
            )
          }
          if (!hasJson) {
            rmSync(options.dataFile)
          }

          expect(() => createProfileStateStore({ ...options, authorityMode })).toThrowError(
            ProfileStateRecoveryRequiredError
          )
          expect(existsSync(options.databaseFile)).toBe(false)
          expect(existsSync(options.dataFile)).toBe(hasJson)
          if (hasJson) {
            expect(readFileSync(options.dataFile, 'utf8')).toBe(source)
          }
        }
      )
    }
  )
})
