import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  beginWslAuthSurfaceTest,
  createCredentialsJson,
  createSettings,
  createStore,
  createWslAccount,
  createWslDistroHome,
  createWslManagedAuth,
  endWslAuthSurfaceTest,
  listDistroSnapshotFiles,
  mockWsl,
  readJson,
  testState
} from './wsl-auth-surface.test-fixtures'

// Regression coverage for #11824: a managed WSL account must be an auth-only swap
// against the distro's own ~/.claude, not a whole-profile CLAUDE_CONFIG_DIR switch.

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

describe('Claude runtime auth on WSL distro profiles', () => {
  beforeEach(beginWslAuthSurfaceTest)
  afterEach(endWslAuthSurfaceTest)

  it('keeps the distro profile as the config dir and materializes only the credentials', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const managedCredentials = createCredentialsJson('second@example.com', 'managed-token')
    const managedAuthPath = createWslManagedAuth('ubuntu-account', managedCredentials)
    const store = createStore(
      createSettings({
        localAccountRuntime: 'wsl',
        localAccountWslDistro: 'Ubuntu',
        claudeManagedAccounts: [
          createWslAccount('ubuntu-account', 'Ubuntu', managedAuthPath, 'second@example.com')
        ],
        activeClaudeManagedAccountId: null,
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

    expect(preparation.configDir).toBe(join(wslHome, '.claude'))
    expect(preparation.wslLinuxConfigDir).toBe('/home/alice/.claude')
    expect(preparation.envPatch.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(preparation.provenance).toBe('managed:ubuntu-account:wsl:Ubuntu')
    expect(existsSync(join(preparation.configDir, 'settings.json'))).toBe(true)
    expect(existsSync(join(preparation.configDir, 'plugins'))).toBe(true)
    expect(existsSync(join(preparation.configDir, 'CLAUDE.md'))).toBe(true)

    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      managedCredentials
    )
    const distroConfig = readJson(join(wslHome, '.claude.json'))
    expect(distroConfig.oauthAccount).toEqual({
      accountUuid: 'ubuntu-account'
    })
    expect(distroConfig.projects).toEqual({ '/repo': {} })
    // The hidden usage probe's colocated file must never become the identity target.
    expect(existsSync(join(wslHome, '.claude', '.claude.json'))).toBe(false)
    // The Windows-side profile stays untouched.
    expect(existsSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'))).toBe(false)
  })

  it('restores the distro login when the account is deselected', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const ownCredentials = readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
    const store = createStore(
      createSettings({
        localAccountRuntime: 'wsl',
        localAccountWslDistro: 'Ubuntu',
        claudeManagedAccounts: [
          createWslAccount('ubuntu-account', 'Ubuntu', managedAuthPath, 'second@example.com')
        ],
        activeClaudeManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: null }
        }
      })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    store.updateSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'ubuntu-account' }
      }
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    store.updateSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: null }
      }
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      ownCredentials
    )
    expect(readJson(join(wslHome, '.claude.json')).oauthAccount).toEqual({
      accountUuid: 'own-account'
    })
    const preparation = await service.prepareForClaudeLaunch({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(preparation.provenance).toBe('wsl:Ubuntu:system')
  })

  it('keeps the distro login when an already-selected account is first synced after upgrading', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const ownCredentials = readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
    // Upgrade path: the selection is already persisted and no distro snapshot exists, because
    // before #11824 the WSL branch never touched the distro profile at all.
    const store = createStore(
      createSettings({
        localAccountRuntime: 'wsl',
        localAccountWslDistro: 'Ubuntu',
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
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    store.updateSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: null }
      }
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      ownCredentials
    )
    expect(readJson(join(wslHome, '.claude.json'))).toEqual({
      oauthAccount: { accountUuid: 'own-account' },
      projects: { '/repo': {} }
    })
  })

  it('writes the distro .claude.json when the distro confirms it is absent', async () => {
    mockWsl({ wslUncFileExists: () => false })
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    rmSync(join(wslHome, '.claude.json'), { force: true })
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
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
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(readJson(join(wslHome, '.claude.json'))).toEqual({
      oauthAccount: { accountUuid: 'ubuntu-account' }
    })
  })

  it('rewrites the distro identity after a login inside the distro replaced it', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
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
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    // `claude /login` inside the distro rewrites oauthAccount behind Orca's back.
    writeFileSync(
      join(wslHome, '.claude.json'),
      `${JSON.stringify({ oauthAccount: { accountUuid: 'personal-account' }, projects: { '/repo': {} } })}\n`,
      'utf-8'
    )
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(readJson(join(wslHome, '.claude.json')).oauthAccount).toEqual({
      accountUuid: 'ubuntu-account'
    })
  })

  it('keeps distros isolated and folds distro-name casing onto one surface', async () => {
    mockWsl()
    const ubuntuHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const debianHome = createWslDistroHome('Debian', 'owner@example.com')
    const ubuntuCredentials = createCredentialsJson('ubuntu@example.com', 'ubuntu-token')
    const debianCredentials = createCredentialsJson('debian@example.com', 'debian-token')
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createWslAccount(
            'ubuntu-account',
            'Ubuntu',
            createWslManagedAuth('ubuntu-account', ubuntuCredentials),
            'ubuntu@example.com'
          ),
          createWslAccount(
            'debian-account',
            'Debian',
            createWslManagedAuth('debian-account', debianCredentials),
            'debian@example.com'
          )
        ],
        activeClaudeManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: null, ubuntu: null, Debian: null }
        }
      })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Debian'
    })
    store.updateSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: {
          Ubuntu: 'ubuntu-account',
          ubuntu: 'ubuntu-account',
          Debian: 'debian-account'
        }
      }
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Debian'
    })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'ubuntu'
    })

    expect(readFileSync(join(ubuntuHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      ubuntuCredentials
    )
    expect(readFileSync(join(debianHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      debianCredentials
    )
    // One snapshot per distro: `Ubuntu` and `ubuntu` must not fork into two surfaces.
    expect(listDistroSnapshotFiles()).toHaveLength(2)
  })

  it('falls back to the isolated auth slot when the distro cannot be reached', async () => {
    mockWsl({ getWslHome: () => null })
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
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

    expect(preparation.configDir).toBe(managedAuthPath)
    expect(preparation.envPatch.CLAUDE_CONFIG_DIR).toBe(
      '/home/alice/.local/share/orca/claude-accounts/ubuntu-account/auth'
    )
    expect(existsSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'))).toBe(false)
  })

  it('reads a live refresh out of the distro profile back into managed storage', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token', Date.now() + 60_000)
    )
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
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    const refreshed = createCredentialsJson(
      'second@example.com',
      'refreshed-token',
      Date.now() + 3_600_000
    )
    writeFileSync(join(wslHome, '.claude', '.credentials.json'), refreshed, 'utf-8')
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')).toBe(refreshed)
  })

  it('suppresses the next WSL read-back after a re-authentication', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const managedAuthPath = createWslManagedAuth(
      'ubuntu-account',
      createCredentialsJson('second@example.com', 'managed-token')
    )
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
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    // Re-auth writes fresh managed tokens while the distro still holds the stale copy.
    const reauthed = createCredentialsJson(
      'second@example.com',
      'reauthed-token',
      Date.now() + 3_600_000
    )
    writeFileSync(join(managedAuthPath, '.credentials.json'), reauthed, 'utf-8')
    service.clearLastWrittenCredentialsJson('ubuntu-account')
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')).toBe(reauthed)
    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(reauthed)
  })

  it('keeps host and WSL materialization state independent', async () => {
    mockWsl()
    const wslHome = createWslDistroHome('Ubuntu', 'owner@example.com')
    const hostCredentials = createCredentialsJson('host@example.com', 'host-token')
    const wslCredentials = createCredentialsJson('wsl@example.com', 'wsl-token')
    const hostAuthPath = createWslManagedAuth('host-account', hostCredentials)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          {
            ...createWslAccount('host-account', 'Ubuntu', hostAuthPath, 'host@example.com'),
            managedAuthRuntime: 'host',
            wslDistro: null,
            wslLinuxAuthPath: null
          },
          createWslAccount(
            'wsl-account',
            'Ubuntu',
            createWslManagedAuth('wsl-account', wslCredentials),
            'wsl@example.com'
          )
        ],
        activeClaudeManagedAccountId: 'host-account',
        activeClaudeManagedAccountIdsByRuntime: {
          host: 'host-account',
          wsl: { Ubuntu: 'wsl-account' }
        }
      })
    )

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection({ runtime: 'host' })
    await service.syncForCurrentSelection({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    await service.syncForCurrentSelection({ runtime: 'host' })

    expect(readFileSync(join(testState.fakeHomeDir, '.claude', '.credentials.json'), 'utf-8')).toBe(
      hostCredentials
    )
    expect(readFileSync(join(wslHome, '.claude', '.credentials.json'), 'utf-8')).toBe(
      wslCredentials
    )
    expect(readFileSync(join(hostAuthPath, '.credentials.json'), 'utf-8')).toBe(hostCredentials)
  })
})
