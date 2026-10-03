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

const profiles = vi.hoisted(() => {
  const state: {
    authority?: {
      routes: (target?: { runtime?: string; wslDistro?: string | null }) => boolean
      prepare: ReturnType<typeof vi.fn>
      publish: ReturnType<typeof vi.fn>
      retire: ReturnType<typeof vi.fn>
      startup: ReturnType<typeof vi.fn>
    }
  } = {}
  return state
})
vi.mock('./claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => profiles.authority,
  installClaudeProfileRoutingAuthority: () => {}
}))

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

  it('launches a WSL distro with no Orca account as System Default, with no guest call', async () => {
    setPlatform('win32')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => null,
      toWindowsWslPath: (value: string) => value
    }))
    profiles.authority = {
      routes: (target) => target?.runtime !== 'wsl' || target.wslDistro === 'Ubuntu',
      prepare: vi.fn(async () => {
        throw new Error(
          'WSL distro Arch is not running. Start it before choosing a Claude account.'
        )
      }),
      publish: vi.fn(async () => {}),
      retire: vi.fn(async () => {}),
      startup: vi.fn(async () => {})
    }
    const store = createStore(createSettings({ claudeManagedAccounts: [] }))
    try {
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      const service = new ClaudeRuntimeAuthService(store as never)
      const arch = { runtime: 'wsl' as const, wslDistro: 'Arch' }
      await expect(service.prepareForClaudeLaunch(arch)).resolves.toMatchObject({
        runtime: 'wsl',
        envPatch: {},
        provenance: 'wsl:Arch:system'
      })
      await service.syncForCurrentSelection(arch)
      expect(profiles.authority.prepare).not.toHaveBeenCalled()
      expect(profiles.authority.publish).not.toHaveBeenCalled()
      expect(profiles.authority.retire).toHaveBeenCalledWith(arch, 'if-running')
      await expect(
        service.prepareForClaudeLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      ).rejects.toThrow('not running')
      // Why: retire is only for a WSL distro that lost its accounts, never for the host.
      await service.syncForCurrentSelection({ runtime: 'host' })
      expect(profiles.authority.publish).toHaveBeenCalledWith(
        { runtime: 'host' },
        'always',
        'if-running'
      )
      expect(profiles.authority.retire).toHaveBeenCalledTimes(1)
      // Gate off: no authority, so selection takes the legacy path and never retires.
      const routing = profiles.authority
      profiles.authority = undefined
      await service.syncForCurrentSelection(arch)
      await service.forceMaterializeCurrentSelectionForRollback(arch)
      expect(routing.retire).toHaveBeenCalledTimes(1)
    } finally {
      profiles.authority = undefined
    }
  })
})
