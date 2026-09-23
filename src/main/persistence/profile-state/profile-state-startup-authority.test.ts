import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  createProfileStateStoreForStartup,
  desktopProfileStateAuthorityMode,
  orcadProfileStateAuthorityMode,
  ProfileStateStartupAuthorityError,
  type ProfileStateStartupAuthorityOptions
} from './profile-state-startup-authority'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('profile-state startup authority boundary', () => {
  it('establishes desktop SQLite by default while preserving orcad capability selection', () => {
    expect(desktopProfileStateAuthorityMode()).toBe('sqlite-candidate')
    expect(orcadProfileStateAuthorityMode(true)).toBe('sqlite-candidate')
    expect(orcadProfileStateAuthorityMode(false)).toBe('legacy')
  })

  it('imports legacy desktop state by default and reopens acknowledged SQLite state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-startup-authority-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = profileStateDatabaseFile(directory)
    writeFileSync(dataFile, JSON.stringify(buildProfileStateCutoverFixture(directory)))

    const base: Omit<ProfileStateStartupAuthorityOptions, 'runtime' | 'authorityMode'> = {
      dataFile,
      databaseFile,
      profileId: 'startup-authority-test',
      storageAuthority: 'desktop'
    }
    const legacy = createProfileStateStoreForStartup({
      ...base,
      runtime: 'desktop',
      authorityMode: 'legacy'
    })
    expect(legacy.backend).toBe('json')
    expect(existsSync(databaseFile)).toBe(false)
    legacy.store.freezeWrites()

    const candidate = createProfileStateStoreForStartup({
      ...base,
      runtime: 'desktop',
      authorityMode: desktopProfileStateAuthorityMode()
    })
    expect(candidate.backend).toBe('sqlite')
    expect(candidate.migrated).toBe(true)
    candidate.store.updateSettings({ theme: 'dark' })
    candidate.store.flushOrThrow()
    candidate.store.freezeWrites()
    rmSync(dataFile)

    const restarted = createProfileStateStoreForStartup({
      ...base,
      runtime: 'desktop',
      authorityMode: desktopProfileStateAuthorityMode()
    })
    expect(restarted.backend).toBe('sqlite')
    expect(restarted.classification).toBe('sqlite-only')
    expect(restarted.store.getSettings().theme).toBe('dark')
    restarted.store.freezeWrites()

    const packaged = createProfileStateStoreForStartup({
      ...base,
      runtime: 'desktop',
      authorityMode: desktopProfileStateAuthorityMode()
    })
    expect(packaged.backend).toBe('sqlite')
    expect(packaged.classification).toBe('sqlite-only')
    expect(packaged.store.getSettings().theme).toBe('dark')
    packaged.store.freezeWrites()

    expect(() =>
      createProfileStateStoreForStartup({
        ...base,
        runtime: 'desktop',
        authorityMode: 'legacy'
      })
    ).toThrowError(expect.objectContaining({ code: 'profile-state-authority-required' }))

    const orcad = createProfileStateStoreForStartup({
      ...base,
      runtime: 'orcad',
      authorityMode: 'sqlite-candidate',
      storageAuthority: 'runtime'
    })
    expect(orcad.backend).toBe('sqlite')
    orcad.store.freezeWrites()

    expect(() =>
      createProfileStateStoreForStartup({
        ...base,
        runtime: 'orcad',
        authorityMode: 'legacy',
        storageAuthority: 'runtime'
      })
    ).toThrowError(expect.objectContaining({ code: 'profile-state-authority-required' }))
  })

  it('rejects an orcad candidate request on a Node 18-style host', () => {
    const original = process.getBuiltinModule
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) => {
      if (id === 'node:sqlite') {
        return undefined
      }
      return original(id)
    })

    expect(() =>
      createProfileStateStoreForStartup({
        dataFile: join(tmpdir(), 'missing-orca-data.json'),
        databaseFile: join(tmpdir(), 'missing-profile-state.db'),
        profileId: 'startup-authority-node18-test',
        runtime: 'orcad',
        authorityMode: 'sqlite-candidate',
        storageAuthority: 'runtime'
      })
    ).toThrowError(ProfileStateStartupAuthorityError)
  })

  it('creates an empty desktop profile directly in SQLite and preserves its first acknowledged write', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-default-empty-profile-'))
    temporaryDirectories.push(directory)
    const options: ProfileStateStartupAuthorityOptions = {
      dataFile: join(directory, 'orca-data.json'),
      databaseFile: profileStateDatabaseFile(directory),
      profileId: 'default-empty',
      runtime: 'desktop',
      authorityMode: desktopProfileStateAuthorityMode(),
      storageAuthority: 'desktop'
    }
    const first = createProfileStateStoreForStartup(options)
    try {
      expect(first.backend).toBe('sqlite')
      expect(first.classification).toBe('neither')
      first.store.updateSettings({ terminalFontSize: 19 })
      first.store.flushOrThrow()
      expect(existsSync(options.databaseFile)).toBe(true)
      expect(existsSync(options.dataFile)).toBe(false)
    } finally {
      first.store.freezeWrites()
    }
    const reopened = createProfileStateStoreForStartup(options)
    try {
      expect(reopened.backend).toBe('sqlite')
      expect(reopened.migrated).toBe(false)
      expect(reopened.store.getSettings().terminalFontSize).toBe(19)
    } finally {
      reopened.store.freezeWrites()
    }
  })

  it.each(['corrupt', 'future-schema', 'ambiguous'] as const)(
    'refuses %s storage under the desktop default without replacing the authority',
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-default-invalid-profile-'))
      temporaryDirectories.push(directory)
      const options: ProfileStateStartupAuthorityOptions = {
        dataFile: join(directory, 'orca-data.json'),
        databaseFile: profileStateDatabaseFile(directory),
        profileId: 'default-invalid',
        runtime: 'desktop',
        authorityMode: desktopProfileStateAuthorityMode(),
        storageAuthority: 'desktop'
      }
      if (kind === 'corrupt') {
        writeFileSync(options.databaseFile, 'not a SQLite database')
      } else {
        const opened = openProfileStateDatabase(options.databaseFile, options.profileId)
        try {
          if (kind === 'future-schema') {
            opened.db.exec('PRAGMA user_version = 999')
          } else {
            writeFileSync(options.dataFile, '{"settings":{"theme":"dark"}}')
          }
        } finally {
          opened.db.close()
        }
      }
      const before = readFileSync(options.databaseFile)
      expect(() => createProfileStateStoreForStartup(options)).toThrow()
      expect(readFileSync(options.databaseFile)).toEqual(before)
      if (kind === 'ambiguous') {
        expect(readFileSync(options.dataFile, 'utf8')).toBe('{"settings":{"theme":"dark"}}')
      }
    }
  )

  it('migrates a JSON-only orcad profile when the runtime exposes SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-orcad-capable-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = profileStateDatabaseFile(directory)
    writeFileSync(dataFile, JSON.stringify({ settings: { theme: 'dark' } }))

    const result = createProfileStateStoreForStartup({
      dataFile,
      databaseFile,
      profileId: 'orcad-capable-test',
      runtime: 'orcad',
      authorityMode: orcadProfileStateAuthorityMode(true),
      storageAuthority: 'runtime'
    })

    expect(result.backend).toBe('sqlite')
    expect(result.migrated).toBe(true)
    expect(result.store.getSettings().theme).toBe('dark')
    result.store.freezeWrites()
  })

  it('keeps a runtime with SQLite but no native backup on JSON authority', () => {
    const original = process.getBuiltinModule
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) => {
      return id === 'node:sqlite' ? { DatabaseSync: class {} } : original(id)
    })
    expect(orcadProfileStateAuthorityMode()).toBe('legacy')
    expect(() =>
      createProfileStateStoreForStartup({
        dataFile: join(tmpdir(), 'missing-backup-orca-data.json'),
        databaseFile: join(tmpdir(), 'missing-backup-profile-state.db'),
        profileId: 'missing-native-backup',
        runtime: 'orcad',
        authorityMode: 'sqlite-candidate',
        storageAuthority: 'runtime'
      })
    ).toThrowError(ProfileStateStartupAuthorityError)
  })

  it('keeps a JSON-only orcad profile on JSON when the runtime lacks SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-orcad-node18-'))
    temporaryDirectories.push(directory)
    const dataFile = join(directory, 'orca-data.json')
    const databaseFile = profileStateDatabaseFile(directory)
    writeFileSync(dataFile, JSON.stringify({ settings: { theme: 'dark' } }))

    const result = createProfileStateStoreForStartup({
      dataFile,
      databaseFile,
      profileId: 'orcad-node18-test',
      runtime: 'orcad',
      authorityMode: orcadProfileStateAuthorityMode(false),
      storageAuthority: 'runtime'
    })

    expect(result.backend).toBe('json')
    expect(result.migrated).toBe(false)
    expect(result.store.getSettings().theme).toBe('dark')
    result.store.freezeWrites()
  })
})
