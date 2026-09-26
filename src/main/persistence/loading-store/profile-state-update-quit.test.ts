import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as durableFiles from '../../durable-file-write'
import { settleTeardownWithinDeadline } from '../../quit-teardown-deadline'
import { openProfileStateDatabaseReadOnly } from '../profile-state/profile-state-database'
import {
  hashProfileStateJson,
  readProfileStateJsonAcceptance,
  readProfileStateSnapshot
} from '../profile-state/profile-state-documents'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { createProfileStateStore } from '../profile-state/profile-state-store-factory'
import { Store } from './store'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
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

const PROFILE_ID = 'update-quit-test'
const TARGET_ID = 'remote-host'
const fixtures: { directory: string; store: Store; authority: ProfileStateSqliteAuthority }[] = []
const releases: (() => void)[] = []

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release()
  }
  for (const { store, authority, directory } of fixtures.splice(0)) {
    await store.flushAsync()
    await authority.drainBackups()
    store.freezeWrites()
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-update-quit-'))
  const databasePath = join(directory, 'profile-state.db')
  const dataFile = join(directory, 'orca-data.json')
  const authority = new ProfileStateSqliteAuthority(databasePath, PROFILE_ID)
  const store = new Store({ dataFile, profileStateAuthority: authority })
  fixtures.push({ directory, store, authority })
  store.upsertSshRemotePtyLease({ targetId: TARGET_ID, ptyId: 'remote-pty', state: 'attached' })
  await store.flushPendingOrThrowAsync()
  store.writeLatestProfileStateJsonExport()
  store.writeLatestProfileStateJsonCompatibilityExport()
  return { store, authority, databasePath, dataFile }
}

function persistedState(databasePath: string) {
  const opened = openProfileStateDatabaseReadOnly(databasePath, PROFILE_ID)
  try {
    return {
      ...readProfileStateSnapshot(opened.db),
      acceptance: readProfileStateJsonAcceptance(opened.db)
    }
  } finally {
    opened.db.close()
  }
}

function gate() {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { promise, release }
}

describe('SQLite profile state during an update quit', () => {
  it('exports final SSH shutdown writes and reloads them in a JSON-only Store', async () => {
    const { store, dataFile, databasePath } = await fixture()
    store.markSshRemotePtyLeasesForShutdown(TARGET_ID, 'detached')

    await store.flushAsync({ exportJsonCompatibility: true })

    const json = readFileSync(dataFile, 'utf8')
    const snapshot = persistedState(databasePath)
    expect(json).toBe(snapshot.json)
    expect(snapshot.acceptance).toEqual({
      jsonHash: hashProfileStateJson(json),
      acceptedRevision: snapshot.revision
    })
    const legacy = new Store({ dataFile })
    try {
      expect(legacy.getSshRemotePtyLeases(TARGET_ID)).toEqual([
        expect.objectContaining({ state: 'detached', lastDetachedAt: expect.any(Number) })
      ])
    } finally {
      legacy.freezeWrites()
    }
  })

  it('exports a normal quit for an older build after sessions and settings changed', async () => {
    const { store, dataFile, databasePath } = await fixture()
    store.updateSettings({ theme: 'dark' })
    store.markSshRemotePtyLeasesForShutdown(TARGET_ID, 'detached')

    await store.flushFinalOrThrowAsync({ exportJsonCompatibility: true })

    const json = readFileSync(dataFile, 'utf8')
    expect(json).toBe(persistedState(databasePath).json)
    const legacy = new Store({ dataFile })
    try {
      expect(legacy.getSettings().theme).toBe('dark')
      expect(legacy.getSshRemotePtyLeases(TARGET_ID)[0]?.state).toBe('detached')
    } finally {
      legacy.freezeWrites()
    }
  })

  it('does not publish or accept a snapshot when final persistence fails', async () => {
    const { store, authority, dataFile, databasePath } = await fixture()
    const retainedJson = readFileSync(dataFile, 'utf8')
    const before = persistedState(databasePath)
    const failure = new Error('injected final commit failure')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementation(() => {
      throw failure
    })
    const exportJson = vi.spyOn(authority, 'writeJsonCompatibilityExportAsync')
    store.markSshRemotePtyLeasesForShutdown(TARGET_ID, 'detached')

    await store.flushAsync({ exportJsonCompatibility: true })

    expect(exportJson).not.toHaveBeenCalled()
    expect(readFileSync(dataFile, 'utf8')).toBe(retainedJson)
    expect(persistedState(databasePath)).toEqual(before)
  })

  it('retains the preflight export and acceptance if the final file write fails', async () => {
    const { store, dataFile, databasePath } = await fixture()
    const retainedJson = readFileSync(dataFile, 'utf8')
    const before = persistedState(databasePath)
    const failure = new Error('injected final export failure')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(durableFiles, 'writeFileDurable').mockRejectedValueOnce(failure)
    store.markSshRemotePtyLeasesForShutdown(TARGET_ID, 'detached')

    await store.flushAsync({ exportJsonCompatibility: true })

    expect(readFileSync(dataFile, 'utf8')).toBe(retainedJson)
    expect(persistedState(databasePath).acceptance).toMatchObject(before.acceptance ?? {})
    expect(persistedState(databasePath).revision).toBeGreaterThan(before.revision)
    expect(log).toHaveBeenCalledWith('[persistence] Failed to flush final state:', failure)
  })

  it('joins the final barrier and permits its deadline while the JSON file write stalls', async () => {
    const { store, dataFile, databasePath } = await fixture()
    const retainedJson = readFileSync(dataFile, 'utf8')
    const writing = gate()
    const held = gate()
    const writeFileDurable = durableFiles.writeFileDurable
    const exportWrite = vi
      .spyOn(durableFiles, 'writeFileDurable')
      .mockImplementationOnce(async (...args) => {
        writing.release()
        await held.promise
        await writeFileDurable(...args)
      })
    store.markSshRemotePtyLeasesForShutdown(TARGET_ID, 'detached')
    const pending = store.flushAsync({ exportJsonCompatibility: true })
    expect(store.flushAsync()).toBe(pending)
    await writing.promise

    await expect(
      settleTeardownWithinDeadline([{ name: 'state', promise: pending }], 25)
    ).resolves.toEqual(['state'])
    expect(readFileSync(dataFile, 'utf8')).toBe(retainedJson)
    held.release()
    await pending

    expect(exportWrite).toHaveBeenCalledOnce()
    expect(readFileSync(dataFile, 'utf8')).toBe(persistedState(databasePath).json)
  })

  it('reopens the latest SQLite state when a concurrent commit prevents export promotion', async () => {
    const { store, dataFile, databasePath } = await fixture()
    const before = persistedState(databasePath)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const writeFileDurable = durableFiles.writeFileDurable
    vi.spyOn(durableFiles, 'writeFileDurable').mockImplementationOnce(async (...args) => {
      await writeFileDurable(...args)
      const competitor = new ProfileStateSqliteAuthority(databasePath, PROFILE_ID)
      try {
        competitor.readSerializedState()
        competitor.writeSerializedDomains([{ domain: 'settings', payload: '{"theme":"dark"}' }])
      } finally {
        competitor.close()
      }
    })
    store.markSshRemotePtyLeasesForShutdown(TARGET_ID, 'detached')

    await store.flushAsync({ exportJsonCompatibility: true })

    const snapshot = persistedState(databasePath)
    expect(snapshot.acceptance).toMatchObject(before.acceptance ?? {})
    expect(snapshot.acceptance?.pending?.jsonHash).toBe(
      hashProfileStateJson(readFileSync(dataFile, 'utf8'))
    )
    expect(log).toHaveBeenCalledWith(
      '[persistence] Failed to flush final state:',
      expect.objectContaining({ code: 'profile-state-revision-conflict' })
    )
    store.freezeWrites()
    const reopened = createProfileStateStore({
      dataFile,
      databaseFile: databasePath,
      profileId: PROFILE_ID,
      authorityMode: 'sqlite-established'
    })
    try {
      expect(reopened.backend).toBe('sqlite')
      expect(reopened.store.getSettings().theme).toBe('dark')
      expect(reopened.store.getSshRemotePtyLeases(TARGET_ID)[0]?.state).toBe('detached')
    } finally {
      reopened.store.freezeWrites()
    }
  })
})
