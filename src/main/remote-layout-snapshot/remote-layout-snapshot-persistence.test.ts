import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { setSecretStore } from '../../shared/secret-store'
import { recordRemoteLayoutFrame } from './remote-layout-snapshot-recorder'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { Store } from '../persistence/loading-store/store'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []
const stores: Store[] = []

beforeEach(() => {
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(plaintext),
    decryptString: (ciphertext) => ciphertext.toString(),
    describeProtectionGap: () => null
  })
  vi.spyOn(ProfileStateSqliteAuthority.prototype, 'scheduleBackup').mockImplementation(() => {})
})

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
    await store.flushAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function profile(seeded: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-remote-layout-snapshot-'))
  directories.push(directory)
  const databasePath = join(directory, 'profile-state.db')
  const profileId = 'remote-layout-snapshot'
  new ProfileStateSqliteAuthority(databasePath, profileId).writeSerializedState(
    Buffer.from(JSON.stringify({ ...getDefaultPersistedState(directory), ...seeded }))
  )
  const open = () => {
    const store = new Store({
      dataFile: join(directory, 'orca-data.json'),
      profileStateAuthority: new ProfileStateSqliteAuthority(databasePath, profileId)
    })
    stores.push(store)
    return store
  }
  return { open }
}

const workspace = {
  worktree: 'repo::/srv/repo',
  publicationEpoch: 'epoch',
  snapshotVersion: 3,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: []
}

it('keeps a title-only change without arming a save, and writes it with the next save', () => {
  const { open } = profile()
  const store = open()
  const record = (result: Record<string, unknown>) =>
    recordRemoteLayoutFrame(store, 'env', 'session.tabs.subscribeAll', {
      id: 'stream',
      ok: true,
      result,
      _meta: { runtimeId: 'server' }
    })
  record({ type: 'snapshots', snapshots: [workspace] })
  store.flushOrThrow()

  const timers = vi.spyOn(globalThis, 'setTimeout')
  const retitled = { ...workspace, snapshotVersion: 4 }
  record({ type: 'updated', ...retitled })
  expect(timers).not.toHaveBeenCalled()
  timers.mockRestore()

  // Another domain's save writes only the domains marked dirty, which must include this one.
  store.updateSettings({ opencodeSessionCookie: 'cookie' })
  store.flushOrThrow()
  expect(open().getRemoteLayoutSnapshots().env?.workspaces[workspace.worktree]).toEqual(retitled)
})
