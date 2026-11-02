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
  const revision = (domain: string) => {
    const opened = openProfileStateDatabaseReadOnly(databasePath, profileId)
    try {
      const row = opened.db
        .prepare('SELECT revision FROM profile_state_documents WHERE domain = ?')
        .get(domain)
      return row ? Number(row.revision) : undefined
    } finally {
      opened.db.close()
    }
  }
  return { open, revision }
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
  addedAt: 3,
  kind: 'folder'
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

it('replaces the saved list with each answer and saves nothing when it is unchanged', () => {
  const { open, revision } = profile()
  const store = open()
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld, django]))
  store.flushOrThrow()
  const afterFirst = revision('hostRepoCatalogSnapshots')

  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld, django]))
  store.flushOrThrow()
  expect(revision('hostRepoCatalogSnapshots')).toBe(afterFirst)

  // django was deleted on the host.
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld]))
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

  const saved = listHostRepoCatalogSnapshots(open(), [wslHost, otherWslHost, pairedServer])
  expect(Object.keys(saved).sort()).toEqual(['env-wsl', 'env-wsl-2'])
  expect(saved['env-wsl']?.repos.map((repo) => repo.id)).toEqual(['hello'])
  expect(saved['env-wsl-2']?.repos.map((repo) => repo.id)).toEqual(['django'])
})

it('forgets a removed host, and never lists one no longer saved', () => {
  const { open } = profile()
  const store = open()
  recordHostRepoCatalogAnswer(store, wslHost, 'repo.list', repoListAnswer([helloWorld]))
  recordHostRepoCatalogAnswer(store, otherWslHost, 'repo.list', repoListAnswer([django]))
  // Removed outside Settings (CLI): the registry no longer has it.
  expect(Object.keys(listHostRepoCatalogSnapshots(store, [wslHost]))).toEqual(['env-wsl'])

  // What Settings removal runs (retireRemovedRuntimeEnvironment).
  store.setHostRepoCatalogSnapshot('env-wsl', null)
  store.flushOrThrow()
  expect(open().getHostRepoCatalogSnapshots()).not.toHaveProperty('env-wsl')
})
