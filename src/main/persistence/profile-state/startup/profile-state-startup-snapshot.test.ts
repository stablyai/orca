import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileStateAuthority } from '../../loading-store/profile-writing/profile-state-authority'
import { Store } from '../../loading-store/store'
import { bootstrapProfileStateAuthority } from './profile-state-authority-bootstrap'
import * as profileStateDatabase from '../database/profile-state-database'

import { importProfileStateJson } from '../documents/profile-state-documents'
import { hashProfileStatePayload as hashProfileStateJson } from '../documents/profile-state-document-validation'
import { ProfileStateSqliteAuthority } from '../profile-state-sqlite-authority'

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

vi.mock('../../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
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
})
