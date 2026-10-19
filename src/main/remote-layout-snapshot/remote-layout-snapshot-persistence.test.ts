import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { setSecretStore } from '../../shared/secret-store'
import { recordRemoteLayoutFrame } from './remote-layout-snapshot-recorder'
import { openProfileStateDatabaseReadOnly } from '../persistence/profile-state/profile-state-database'
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
  const documentRevisions = () => {
    const opened = openProfileStateDatabaseReadOnly(databasePath, profileId)
    try {
      return new Map(
        opened.db
          .prepare('SELECT domain, revision FROM profile_state_documents')
          .all()
          .map((row) => [String(row.domain), Number(row.revision)])
      )
    } finally {
      opened.db.close()
    }
  }
  return { open, documentRevisions }
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

it('survives a restart and saves only its own domain', () => {
  const { open, documentRevisions } = profile()
  const store = open()
  store.flushOrThrow()
  const before = documentRevisions()
  const fullWrite = vi.spyOn(
    ProfileStateSqliteAuthority.prototype,
    'writeCompleteSerializedDomains'
  )

  recordRemoteLayoutFrame(store, 'env', 'session.tabs.subscribeAll', {
    id: 'stream',
    ok: true,
    result: { type: 'snapshots', snapshots: [workspace] },
    _meta: { runtimeId: 'server' }
  })
  store.flushOrThrow()

  // Not a whole-profile serialization per recorded frame.
  expect(fullWrite).not.toHaveBeenCalled()
  const after = documentRevisions()
  const changed = [...after].filter(([domain, revision]) => before.get(domain) !== revision)
  expect(changed.map(([domain]) => domain)).toEqual(['remoteLayoutSnapshots'])
  expect(open().getRemoteLayoutSnapshots()).toEqual({
    env: { workspaces: { [workspace.worktree]: workspace } }
  })
})

it('reads a snapshot an older build saved with its receipt fields, without them', () => {
  const workspaces = { [workspace.worktree]: workspace }
  const { open } = profile({
    remoteLayoutSnapshots: {
      env: { receivedAt: 1, serverRuntimeId: 'server', workspaces }
    }
  })
  expect(open().getRemoteLayoutSnapshots()).toEqual({ env: { workspaces } })
})

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
  expect(open().getRemoteLayoutSnapshot('env')?.workspaces[workspace.worktree]).toEqual(retitled)
})
