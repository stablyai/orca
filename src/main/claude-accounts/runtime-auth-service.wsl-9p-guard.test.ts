import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/types'
import {
  beginWslAuthSurfaceTest,
  createCredentialsJson,
  createSettings,
  createStore,
  createWslAccount,
  createWslDistroHome,
  createWslManagedAuth,
  endWslAuthSurfaceTest,
  enoent,
  listDistroSnapshotFiles,
  mockWsl,
  readJson,
  testState
} from './wsl-auth-surface.test-fixtures'

// Regression coverage for the WSL 9P share reporting ENOENT for files that exist (see
// `wslUncDirectoryExists`). Every read that feeds a snapshot or an ownership decision must fail
// closed on an unconfirmed answer, because a snapshot that records a real login as absent is what
// makes a later restore delete it.

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataDir }
}))

vi.mock('./oauth-refresh', () => ({
  isOauthTokenExpiring: vi.fn(() => false),
  refreshClaudeOauthCredentials: vi.fn(async () => null)
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

vi.mock('./keychain', () => ({
  readActiveClaudeKeychainCredentials: vi.fn(async () => null),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  deleteActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(async () => null),
  writeActiveClaudeKeychainCredentialsForRuntime: vi.fn(async () => {}),
  readManagedClaudeKeychainCredentials: vi.fn(async () => null),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

// Why: a real \\wsl.localhost\ share is unavailable here, so a temp dir stands in for the
// distro home and only that dir is reported as a WSL UNC path.
vi.mock('../../shared/wsl-paths', async () => {
  const actual =
    await vi.importActual<typeof import('../../shared/wsl-paths')>('../../shared/wsl-paths') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    parseWslUncPath: (path: string) => {
      for (const [distro, homeDir] of testState.wslHomeDirs) {
        if (path === homeDir || path.startsWith(`${homeDir}/`)) {
          return { distro, linuxPath: `/home/alice${path.slice(homeDir.length)}` }
        }
      }
      return actual.parseWslUncPath(path)
    }
  }
})

// Why: the share's blindness hits stat *and* read, so a registered path fails both. A guard that
// only defended the stat would be defeated by the read.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      !testState.uncBlindPaths.has(String(path)) && actual.existsSync(path),
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1]
    ) => {
      if (testState.uncBlindPaths.has(String(path))) {
        throw enoent(String(path))
      }
      return actual.readFileSync(path, options)
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    readFile: async (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1]
    ) => {
      if (testState.uncBlindPaths.has(String(path))) {
        throw enoent(String(path))
      }
      return actual.readFile(path, options)
    }
  }
})

describe('Claude runtime auth against a blind WSL 9P share', () => {
  beforeEach(beginWslAuthSurfaceTest)
  afterEach(endWslAuthSurfaceTest)

  it('leaves the distro profile alone when the 9P share hides an existing .claude.json', async () => {
    mockWsl({ wslUncFileExists: () => true })
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const ownCredentials = readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
    testState.uncBlindPaths.add(join(wslHome, '.claude.json'))
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createWslAccount('ubuntu-account', 'Ubuntu', managedAuthPath, 'second@example.com')
        ],
        activeClaudeManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'ubuntu-account' }
        }
      })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    // The share hides the identity file, so it cannot be snapshotted, so nothing may be written:
    // the launch degrades to the isolated slot with the right identity instead.
    expect(preparation.configDir).toBe(managedAuthPath)
    expect(preparation.envPatch.CLAUDE_CONFIG_DIR).toBe(
      '/home/alice/.local/share/orca/claude-accounts/ubuntu-account/auth'
    )
    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      ownCredentials
    )
    expect(listDistroSnapshotFiles()).toEqual([])

    // Settings, plugins and project history survive intact once the share answers again.
    testState.uncBlindPaths.clear()
    expect(readJson(join(wslHome, '.claude.json'))).toEqual({
      oauthAccount: { accountUuid: 'own-account' },
      projects: { '/repo': {} }
    })
  })

  it('never snapshots a hidden distro login as absent, so a deselect cannot delete it', async () => {
    mockWsl({ wslUncFileExists: () => true })
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const ownCredentials = readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
    // The 9P share blanks the distro's only login; a snapshot recording `null` here would make the
    // deselect below delete it for good.
    testState.uncBlindPaths.add(join(wslHome, '.claude', '.credentials.json'))
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createWslAccount('ubuntu-account', 'Ubuntu', managedAuthPath, 'second@example.com')
        ],
        activeClaudeManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'ubuntu-account' }
        }
      })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    store.updateSettings({
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    })
    await service.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(listDistroSnapshotFiles()).toEqual([])
    testState.uncBlindPaths.clear()
    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      ownCredentials
    )
  })

  it('re-snapshots the distro login when a login inside the distro replaced it while Orca was closed', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createWslAccount('ubuntu-account', 'Ubuntu', managedAuthPath, 'second@example.com')
      ],
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'ubuntu-account' }
      }
    })

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const firstRun = new ClaudeRuntimeAuthService(createStore(settings) as never)
    await firstRun.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    // Orca is closed; the user runs `claude /login` inside the distro under their own account.
    const relogin = createCredentialsJson('owner@example.com', 'relogin-token')
    writeFileSync(join(wslHome, '.claude', '.credentials.json'), relogin, 'utf-8')
    writeFileSync(
      join(wslHome, '.claude.json'),
      `${JSON.stringify({ oauthAccount: { accountUuid: 'relogin-account' }, projects: { '/repo': {} } })}\n`,
      'utf-8'
    )

    // A fresh process must not treat the surviving snapshot file as proof it still owns the profile.
    const store = createStore(settings)
    const secondRun = new ClaudeRuntimeAuthService(store as never)
    await secondRun.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    store.updateSettings({
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    })
    await secondRun.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(relogin)
    expect(readJson(join(wslHome, '.claude.json')).oauthAccount).toEqual({
      accountUuid: 'relogin-account'
    })
  })

  it('keeps host materialization state when the WSL distro cannot be reached', async () => {
    const hostCredentials = createCredentialsJson('host@example.com', 'host-token')
    const hostAuthPath = createWslManagedAuth('host-account', hostCredentials)
    const hostAccount: ClaudeManagedAccount = {
      ...createWslAccount('host-account', 'Ubuntu', hostAuthPath, 'host@example.com'),
      managedAuthRuntime: 'host',
      wslDistro: null,
      wslLinuxAuthPath: null
    }
    const ownHostCredentials = createCredentialsJson('owner@example.com', 'own-host-token')
    writeFileSync(
      join(testState.fakeHomeDir, '.claude', '.credentials.json'),
      ownHostCredentials,
      'utf-8'
    )
    // The distro is stopped, so the WSL sync falls back to the host surface — and must not wipe the
    // host's ownership proof on the way past.
    mockWsl({ getWslHome: () => null })
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          hostAccount,
          createWslAccount(
            'wsl-account',
            'Ubuntu',
            createWslManagedAuth(
              'wsl-account',
              createCredentialsJson('wsl@example.com', 'wsl-token')
            ),
            'wsl@example.com'
          )
        ],
        activeClaudeManagedAccountId: null,
        activeClaudeManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'wsl-account' }
        }
      })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection({ runtime: 'host' })
    store.updateSettings({
      activeClaudeManagedAccountId: 'host-account',
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })
    await service.syncForCurrentSelection({ runtime: 'host' })
    expect(readFileSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'), 'utf-8')).toBe(
      hostCredentials
    )

    await service.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    // Removing the account is what exposes a wiped host `lastWrittenCredentialsJson`: there is no
    // managed copy left to fall back to, so the restore has only the tracked state to prove ownership.
    store.updateSettings({
      claudeManagedAccounts: [],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-account' } }
    })
    await service.syncForCurrentSelection({ runtime: 'host' })

    expect(readFileSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'), 'utf-8')).toBe(
      ownHostCredentials
    )
  })
})
