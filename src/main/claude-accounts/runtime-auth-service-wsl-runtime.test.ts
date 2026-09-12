import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())

vi.mock('./oauth-refresh', () => createOauthRefreshMock())

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', () => createKeychainMock())

describe('ClaudeRuntimeAuthService', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('uses account WSL runtime for untargeted Claude preparation instead of stale terminal WSL settings', async () => {
    setPlatform('win32')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => null,
      toWindowsWslPath: (value: string) => value
    }))
    const ubuntuAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'ubuntu-account',
      createClaudeCredentialsJson('ubuntu@example.com', 'ubuntu-token')
    )
    const settings = createSettings({
      localAccountRuntime: 'wsl',
      localAccountWslDistro: 'Ubuntu',
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Debian',
      claudeManagedAccounts: [
        createClaudeAccount('ubuntu-account', ubuntuAuthPath, {
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/alice/.local/share/orca/claude-accounts/ubuntu/auth'
        })
      ],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'ubuntu-account' }
      }
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    expect(service.getRuntimeConfigDir({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
      ubuntuAuthPath
    )
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation).toMatchObject({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxConfigDir: '/home/alice/.local/share/orca/claude-accounts/ubuntu/auth',
      provenance: 'managed:ubuntu-account:wsl:Ubuntu',
      stripAuthEnv: true
    })
  })

  it('uses the global WSL runtime for untargeted Claude preparation under auto', async () => {
    setPlatform('win32')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => null,
      toWindowsWslPath: (value: string) => value
    }))
    const ubuntuAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'ubuntu-account',
      createClaudeCredentialsJson('ubuntu@example.com', 'ubuntu-token')
    )
    const settings = createSettings({
      localAccountRuntime: 'auto',
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
      claudeManagedAccounts: [
        createClaudeAccount('ubuntu-account', ubuntuAuthPath, {
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/alice/.local/share/orca/claude-accounts/ubuntu/auth'
        })
      ],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'ubuntu-account' }
      }
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation).toMatchObject({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      provenance: 'managed:ubuntu-account:wsl:Ubuntu'
    })
  })

  it('ignores a persisted WSL account-runtime pin on non-Windows hosts', async () => {
    setPlatform('darwin')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => null,
      toWindowsWslPath: (value: string) => value
    }))
    const settings = createSettings({
      localAccountRuntime: 'wsl',
      localAccountWslDistro: 'Ubuntu'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation).toMatchObject({
      runtime: 'host',
      wslDistro: null,
      provenance: 'system',
      stripAuthEnv: false
    })
  })

  it('keeps untargeted Claude preparation on host when account runtime is host', async () => {
    setPlatform('win32')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => null,
      toWindowsWslPath: (value: string) => value
    }))
    const settings = createSettings({
      localAccountRuntime: 'host',
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Debian'
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation).toMatchObject({
      runtime: 'host',
      wslDistro: null,
      provenance: 'system',
      stripAuthEnv: false
    })
  })

  it('clears a selected WSL managed account when its credentials are missing', async () => {
    const managedAuthPath = join(testState.userDataDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('account-1', managedAuthPath, {
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/alice/.local/share/orca/claude-accounts/account-1/auth'
        })
      ],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
    })
    const store = createStore(settings)

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    const preparation = await service.prepareForClaudeLaunch({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(store.updateSettings).toHaveBeenCalledWith({
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
    })
    expect(preparation.runtime).toBe('wsl')
    expect(preparation.provenance).toBe('wsl:Ubuntu:system')
    expect(preparation.stripAuthEnv).toBe(true)
  })

  it('uses the default distro selection for WSL-default Claude preparation', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => join(testState.userDataDir, 'wsl-home'),
      toWindowsWslPath: (value: string) => value
    }))
    const ubuntuAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'ubuntu-account',
      createClaudeCredentialsJson('ubuntu@example.com', 'ubuntu-token')
    )
    const debianAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'debian-account',
      createClaudeCredentialsJson('debian@example.com', 'debian-token')
    )
    const settings = createSettings({
      claudeManagedAccounts: [
        createClaudeAccount('ubuntu-account', ubuntuAuthPath, {
          managedAuthRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/alice/.local/share/orca/claude-accounts/ubuntu/auth'
        }),
        createClaudeAccount('debian-account', debianAuthPath, {
          managedAuthRuntime: 'wsl',
          wslDistro: 'Debian',
          wslLinuxAuthPath: '/home/alice/.local/share/orca/claude-accounts/debian/auth'
        })
      ],
      activeClaudeManagedAccountId: null,
      activeClaudeManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'ubuntu-account', Debian: 'debian-account' }
      }
    })
    const store = createStore(settings)

    try {
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      const service = new ClaudeRuntimeAuthService(store as never)
      const preparation = await service.prepareForClaudeLaunch({
        runtime: 'wsl',
        wslDistro: null
      })

      expect(preparation).toMatchObject({
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxConfigDir: '/home/alice/.local/share/orca/claude-accounts/ubuntu/auth',
        provenance: 'managed:ubuntu-account:wsl:Ubuntu',
        stripAuthEnv: true
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
