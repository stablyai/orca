import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { setSecretStore } from '../../shared/secret-store'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  listHostRepoCatalogSnapshots,
  recordHostRepoCatalogAnswer
} from './host-repo-catalog-snapshot-recorder'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { Store } from '../persistence/loading-store/store'
import { retireRemovedRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-removal-cleanup'

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

function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-host-repo-catalog-'))
  directories.push(directory)
  const databasePath = join(directory, 'profile-state.db')
  const profileId = 'host-repo-catalog'
  new ProfileStateSqliteAuthority(databasePath, profileId).writeSerializedState(
    Buffer.from(JSON.stringify(getDefaultPersistedState(directory)))
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

const wslHost = {
  id: 'env-wsl',
  orcadDeployment: { kind: 'wsl' as const, distro: 'Ubuntu', localPort: 41000, remotePort: 6768 }
}
const otherWslHost = {
  id: 'env-wsl-2',
  orcadDeployment: { kind: 'wsl' as const, distro: 'Debian', localPort: 41001, remotePort: 6768 }
}
const pairedServer = { id: 'env-paired', orcadDeployment: null }

function repoListAnswer(repos: unknown[]): RuntimeRpcResponse<unknown> {
  return { id: 'repo.list', ok: true, result: { repos }, _meta: { runtimeId: 'server' } }
}

const helloWorld = {
  id: 'hello',
  path: '/home/me/Hello-World',
  displayName: 'Hello-World',
  badgeColor: '#22c55e',
  addedAt: 1,
  kind: 'git',
  // Host-only detail the sidebar row does not need.
  hookSettings: { setupScript: 'make' }
}
const django = {
  id: 'django',
  path: '/home/me/django',
  displayName: 'django',
  badgeColor: '#737373',
  addedAt: 2
}
const notes = {
  id: 'notes',
  path: '/home/me/notes',
  displayName: 'notes',
  badgeColor: '#737373',
  addedAt: 3,
  kind: 'folder' as const
}

it("keeps a WSL host's projects across a restart, with only the row fields", () => {
  const { open } = profile()
  const store = open()
  recordHostRepoCatalogAnswer(
    store,
    wslHost,
    'repo.list',
    repoListAnswer([helloWorld, django, notes])
  )
  store.flushOrThrow()

  const restarted = open()
  expect(listHostRepoCatalogSnapshots(restarted, [wslHost])).toEqual({
    'env-wsl': {
      repos: [
        {
          id: 'hello',
          path: '/home/me/Hello-World',
          displayName: 'Hello-World',
          badgeColor: '#22c55e',
          addedAt: 1,
          kind: 'git'
        },
        {
          id: 'django',
          path: '/home/me/django',
          displayName: 'django',
          badgeColor: '#737373',
          addedAt: 2
        },
        // A folder project keeps its kind so it renders as a folder while the host sleeps.
        expect.objectContaining({ id: 'notes', kind: 'folder' })
      ]
    }
  })
})

it('replaces the saved list with each answer and saves only when it changed', () => {
  const { open } = profile()
  const store = open()
  let writes = 0
  store.onStateWritten((domains) => {
    if (domains?.includes('hostRepoCatalogSnapshots')) {
      writes++
    }
  })
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld, django]))
  expect(writes).toBe(1)

  // Every catalog refresh lands here; an identical answer must not schedule a save.
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld, django]))
  expect(writes).toBe(1)

  // django was deleted on the host.
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld]))
  expect(writes).toBe(2)
  store.flushOrThrow()
  expect(
    listHostRepoCatalogSnapshots(open(), [wslHost])['env-wsl']?.repos.map((repo) => repo.id)
  ).toEqual(['hello'])
})

it('keeps each distro separately and ignores failures, other methods and paired servers', () => {
  const { open } = profile()
  const store = open()
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld]))
  recordHostRepoCatalogAnswer(store, otherWslHost, 'repo.list', repoListAnswer([django]))
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', {
    id: 'repo.list',
    ok: false,
    error: { code: 'wsl_distro_stopped', message: 'stopped' },
    _meta: { runtimeId: 'server' }
  })
  recordHostRepoCatalogAnswer(store, wslHost, 'worktree.list', repoListAnswer([]))
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', {
    id: 'repo.list',
    ok: true,
    result: { nope: true },
    _meta: { runtimeId: 'server' }
  })
  recordHostRepoCatalogAnswer(store, pairedServer, 'repo.list', repoListAnswer([notes]))
  store.flushOrThrow()

  // Checked in storage, not through the listing, which filters paired servers on its own.
  const stored = open().getHostRepoCatalogSnapshots()
  expect(Object.keys(stored).sort()).toEqual(['env-wsl', 'env-wsl-2'])
  expect(stored['env-wsl']?.repos.map((repo) => repo.id)).toEqual(['hello'])
  expect(stored['env-wsl-2']?.repos.map((repo) => repo.id)).toEqual(['django'])
})

it('lists only WSL hosts, even when a paired server has a saved entry', () => {
  const { open } = profile()
  const store = open()
  store.setHostRepoCatalogSnapshot('env-paired', { repos: [notes] })
  store.setHostRepoCatalogSnapshot('env-wsl', { repos: [django] })
  expect(Object.keys(listHostRepoCatalogSnapshots(store, [wslHost, pairedServer]))).toEqual([
    'env-wsl'
  ])
})

it('never lists a host no longer saved (removed outside Settings)', () => {
  const { open } = profile()
  const store = open()
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld]))
  recordHostRepoCatalogAnswer(store, otherWslHost, 'repo.list', repoListAnswer([django]))
  expect(Object.keys(listHostRepoCatalogSnapshots(store, [wslHost]))).toEqual(['env-wsl'])
})

it('does not seed stale projects when a removed WSL host is added back under the same id', async () => {
  const { open } = profile()
  const store = open()
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld, django]))

  await retireRemovedRuntimeEnvironment(wslHost.id, () => undefined, store)
  store.flushOrThrow()

  // WSL host ids are deterministic per distro, so re-adding it saves the same id again.
  expect(listHostRepoCatalogSnapshots(open(), [wslHost])).toEqual({})
})
