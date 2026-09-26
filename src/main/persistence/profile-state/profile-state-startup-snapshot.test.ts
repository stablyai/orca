import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileStateAuthority } from '../loading-store/profile-state-authority'
import { Store } from '../loading-store/store'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import * as profileStateDatabase from './profile-state-database'
import * as profileStateDocumentReader from './profile-state-document-reader'
import { hashProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createProfileStateStore } from './profile-state-store-factory'

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

const directories: string[] = []
const stores: Store[] = []
const authorities: ProfileStateAuthority[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  const openedStores = stores.splice(0)
  const openedAuthorities = authorities.splice(0)
  for (const store of openedStores) {
    store.freezeWrites()
  }
  for (const authority of openedAuthorities) {
    authority.close?.()
  }
  for (const store of openedStores) {
    await store.flushAsync()
  }
  await Promise.all(openedAuthorities.map((authority) => authority.drainBackups?.()))
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createPaths(): { dataFile: string; databaseFile: string; profileId: string } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-startup-snapshot-'))
  directories.push(directory)
  return {
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: join(directory, 'profile-state.db'),
    profileId: 'startup-snapshot-test'
  }
}

function createEstablishedProfile(keepJson: boolean): ReturnType<typeof createPaths> {
  const paths = createPaths()
  const source = JSON.stringify({ settings: { theme: 'dark' }, futureDomain: { keep: true } })
  if (keepJson) {
    writeFileSync(paths.dataFile, source)
  }
  const opened = profileStateDatabase.openProfileStateDatabase(paths.databaseFile, paths.profileId)
  try {
    importProfileStateJson(opened.db, source, {
      acceptedLegacyJsonHash: hashProfileStateJson(source)
    })
  } finally {
    opened.db.close()
  }
  return paths
}

describe('profile state startup snapshot handoff', () => {
  it('keeps serialized-only authorities usable without SQLite capability', () => {
    const paths = createPaths()
    const original = process.getBuiltinModule
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id) =>
      id === 'node:sqlite' ? undefined : original(id)
    )
    let serialized = '{"settings":{"theme":"dark"},"futureDomain":{"keep":true}}'
    const authority: ProfileStateAuthority = {
      readSerializedState: () => serialized,
      writeSerializedState: (payload) => {
        serialized = payload.toString('utf8')
      }
    }
    const store = new Store({ dataFile: paths.dataFile, profileStateAuthority: authority })
    stores.push(store)
    expect(store.getSettings().theme).toBe('dark')
    expect(store.getSettings().terminalFontSize).toBeGreaterThan(0)
    store.updateSettings({ theme: 'light' })
    store.flushOrThrow()
    expect(JSON.parse(serialized)).toMatchObject({
      settings: { theme: 'light' },
      futureDomain: { keep: true }
    })
  })

  it.each([false, true])('reads established storage once with retained JSON=%s', (keepJson) => {
    const paths = createEstablishedProfile(keepJson)
    const open = vi.spyOn(profileStateDatabase, 'openProfileStateDatabaseReadOnly')
    const documentRead = vi.spyOn(profileStateDocumentReader, 'readProfileStateDocuments')
    const initialRead = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'readInitialState')
    const serializedRead = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'readSerializedState')
    const acceptedRead = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'readAcceptedState')

    const result = createProfileStateStore({ ...paths, authorityMode: 'sqlite-established' })
    stores.push(result.store)

    expect(open).toHaveBeenCalledTimes(1)
    expect(documentRead).toHaveBeenCalledTimes(1)
    expect(initialRead).toHaveBeenCalledTimes(keepJson ? 0 : 1)
    expect(serializedRead).not.toHaveBeenCalled()
    expect(acceptedRead).toHaveBeenCalledTimes(keepJson ? 1 : 0)
    expect(result.store.getSettings().theme).toBe('dark')
    expect(JSON.parse(result.store.prepareProfileStateExport().json)).toMatchObject({
      futureDomain: { keep: true }
    })
  })

  it('uses the validated empty snapshot without rereading SQLite or consulting JSON', () => {
    const paths = createPaths()
    const opened = profileStateDatabase.openProfileStateDatabase(
      paths.databaseFile,
      paths.profileId
    )
    opened.db.close()
    const bootstrapped = bootstrapProfileStateAuthority(paths)
    if (bootstrapped.authority === undefined) {
      throw new Error('Expected SQLite authority')
    }
    authorities.push(bootstrapped.authority)
    expect(bootstrapped.initialState.serializedState).toBeUndefined()
    const read = vi.spyOn(bootstrapped.authority, 'readSerializedState')
    writeFileSync(paths.dataFile, '{"settings":{"opencodeSessionCookie":"stale-json"}}')

    const store = new Store({
      dataFile: paths.dataFile,
      profileStateAuthority: bootstrapped.authority,
      initialAuthorityState: bootstrapped.initialState
    })
    stores.push(store)

    expect(read).not.toHaveBeenCalled()
    expect(store.getSettings().opencodeSessionCookie).not.toBe('stale-json')
    store.updateSettings({ theme: 'dark' })
    store.flushOrThrow()
    expect(readFileSync(paths.dataFile, 'utf8')).toContain('stale-json')
    expect(bootstrapped.authority.readSerializedState()).toContain('"dark"')
  })

  it('consumes a parsed startup snapshot once, including an empty revision', () => {
    const paths = createPaths()
    const opened = profileStateDatabase.openProfileStateDatabase(
      paths.databaseFile,
      paths.profileId
    )
    opened.db.close()
    const authority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    authorities.push(authority)
    const initial = authority.readInitialState()
    expect(initial.takeParsedState?.()).toBeUndefined()
    expect(() => initial.takeParsedState?.()).toThrow('already been consumed')
  })

  it.each([false, true])(
    'fences a writer between bootstrap and Store construction with retained JSON=%s',
    (keepJson) => {
      const paths = createEstablishedProfile(keepJson)
      const bootstrapped = bootstrapProfileStateAuthority(paths)
      if (bootstrapped.authority === undefined) {
        throw new Error('Expected SQLite authority')
      }
      authorities.push(bootstrapped.authority)
      const opened = profileStateDatabase.openProfileStateDatabase(
        paths.databaseFile,
        paths.profileId
      )
      try {
        importProfileStateJson(opened.db, '{"settings":{"theme":"light"}}', {
          expectedRevision: 1
        })
      } finally {
        opened.db.close()
      }

      const store = new Store({
        dataFile: paths.dataFile,
        profileStateAuthority: bootstrapped.authority,
        initialAuthorityState: bootstrapped.initialState
      })
      stores.push(store)

      expect(store.getSettings().theme).toBe('dark')
      store.updateSettings({ theme: 'system' })
      expect(() => store.flushOrThrow()).toThrowError(
        expect.objectContaining({
          code: 'profile-state-revision-conflict',
          expectedRevision: 1,
          actualRevision: 2
        })
      )
      expect(bootstrapped.authority.readSerializedState()).toBe('{"settings":{"theme":"light"}}')
    }
  )

  it('restores the captured fence after a same-authority refresh', () => {
    const paths = createEstablishedProfile(true)
    const authority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    authorities.push(authority)
    const initial = authority.readInitialState()
    const writer = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    authorities.push(writer)
    writer.writeSerializedState(Buffer.from('{"settings":{"theme":"light"}}'))
    expect(authority.readSerializedState()).toContain('"light"')

    const store = new Store({
      dataFile: paths.dataFile,
      profileStateAuthority: authority,
      initialAuthorityState: initial
    })
    stores.push(store)
    store.updateSettings({ theme: 'system' })
    expect(() => store.flushOrThrow()).toThrowError(
      expect.objectContaining({ code: 'profile-state-revision-conflict', actualRevision: 2 })
    )
    expect(writer.readSerializedState()).toContain('"light"')
  })

  it('keeps direct authority reads fresh after bootstrap', () => {
    const paths = createEstablishedProfile(true)
    const bootstrapped = bootstrapProfileStateAuthority(paths)
    if (bootstrapped.authority === undefined) {
      throw new Error('Expected SQLite authority')
    }
    authorities.push(bootstrapped.authority)
    const writer = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    authorities.push(writer)
    writer.writeSerializedState(Buffer.from('{"settings":{"theme":"light"}}'))

    expect(bootstrapped.authority.readSerializedState()).toBe('{"settings":{"theme":"light"}}')
    writer.writeSerializedState(Buffer.from('{"settings":{"theme":"system"}}'))
    expect(bootstrapped.authority.readSerializedState()).toBe('{"settings":{"theme":"system"}}')
  })

  it('decrypts and normalizes the startup snapshot through the existing Store loader', () => {
    const paths = createPaths()
    writeFileSync(paths.dataFile, '{"settings":{"theme":"dark"}}')
    const first = createProfileStateStore({ ...paths, authorityMode: 'sqlite-candidate' }).store
    stores.push(first)
    first.updateSettings({ opencodeSessionCookie: 'startup-secret' })
    first.flushOrThrow()
    first.freezeWrites()

    const reopened = createProfileStateStore({
      ...paths,
      authorityMode: 'sqlite-established'
    }).store
    stores.push(reopened)
    expect(reopened.getSettings().opencodeSessionCookie).toBe('startup-secret')
    expect(reopened.getSettings().terminalFontSize).toBeGreaterThan(0)
    reopened.updateSettings({ theme: 'light' })
    reopened.flushOrThrow()
    expect(reopened.prepareProfileStateExport().json).not.toContain('startup-secret')
    const again = createProfileStateStore({ ...paths, authorityMode: 'sqlite-established' }).store
    stores.push(again)
    expect(again.getSettings().opencodeSessionCookie).toBe('startup-secret')
    expect(again.getSettings().theme).toBe('light')
  })

  it('rejects initial state without its authority or alongside migration input', () => {
    const paths = createPaths()
    const authority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    const otherAuthority = new ProfileStateSqliteAuthority(paths.databaseFile, paths.profileId)
    const initialAuthorityState = { authority, serializedState: '{}' }

    expect(() => new Store({ dataFile: paths.dataFile, initialAuthorityState })).toThrow(
      'must belong to its profile-state authority'
    )
    expect(
      () => new Store({ profileStateAuthority: otherAuthority, initialAuthorityState })
    ).toThrow('must belong to its profile-state authority')
    expect(
      () =>
        new Store({
          profileStateAuthority: authority,
          initialAuthorityState,
          serializedState: '{}'
        })
    ).toThrow('cannot use both a profile-state authority and serialized state')
  })
})
