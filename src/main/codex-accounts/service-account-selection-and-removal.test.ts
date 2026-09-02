import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCodexAuthJson,
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('deselects active account via selectAccount(null)', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const onHostSystemDefaultSelected = vi.fn()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never,
      { onHostSystemDefaultSelected }
    )

    const result = await service.selectAccount(null)

    expect(result.activeAccountId).toBe(null)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalled()
    expect(onHostSystemDefaultSelected).toHaveBeenCalledOnce()
  })

  it('selectAccount switches managed accounts without routing auth through the shared mirror', async () => {
    const firstAuth = createCodexAuthJson('one@example.com', 'acct-one', 'one')
    const secondAuth = createCodexAuthJson('two@example.com', 'acct-two', 'two')
    const firstManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      firstAuth
    )
    const secondManagedHomePath = createManagedHome(
      testState.userDataDir,
      'account-2',
      '',
      secondAuth
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: firstManagedHomePath,
          providerAccountId: 'acct-one',
          workspaceLabel: null,
          workspaceAccountId: 'acct-one',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'account-2',
          email: 'two@example.com',
          managedHomePath: secondManagedHomePath,
          providerAccountId: 'acct-two',
          workspaceLabel: null,
          workspaceAccountId: 'acct-two',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const runtimeHome = new CodexRuntimeHomeService(store as never)
    const runtimeAuthPath = join(testState.userDataDir, 'codex-runtime-home', 'home', 'auth.json')
    expect(existsSync(runtimeAuthPath)).toBe(false)

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await service.selectAccount('account-2')

    // Each managed host account launches against its own home, so a switch must
    // leave both credential files alone and never copy either into the mirror.
    expect(existsSync(runtimeAuthPath)).toBe(false)
    expect(readFileSync(join(firstManagedHomePath, 'auth.json'), 'utf-8')).toBe(firstAuth)
    expect(readFileSync(join(secondManagedHomePath, 'auth.json'), 'utf-8')).toBe(secondAuth)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'launch'))).toBe(false)
    expect(existsSync(join(testState.userDataDir, 'codex-runtime-home', 'active'))).toBe(false)
  })

  it('keeps Windows and WSL active Codex account selections separate', async () => {
    const hostManagedHomePath = createManagedHome(
      testState.userDataDir,
      'host-account',
      '',
      '{"account":"host"}\n'
    )
    const wslManagedHomePath =
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-accounts\\wsl-account\\home'
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'host-account',
          email: 'host@example.com',
          managedHomePath: hostManagedHomePath,
          managedHomeRuntime: 'host',
          wslDistro: null,
          wslLinuxHomePath: null,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/wsl-account/home',
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'host-account',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: {}
      }
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.selectAccountForTarget('wsl-account', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(result.activeAccountId).toBe('host-account')
    expect(result.activeAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(store.getSettings().activeCodexManagedAccountId).toBe('host-account')
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual({
      host: 'host-account',
      wsl: { Ubuntu: 'wsl-account' }
    })
  })

  it('removes an account and cleans up managed home', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.removeAccount('account-1')

    expect(result.accounts).toHaveLength(0)
    expect(result.activeAccountId).toBe(null)
    expect(existsSync(managedHomePath)).toBe(false)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
  })

  it('refuses to remove a managed home owned by a different account', async () => {
    const otherAccountHome = createManagedHome(
      testState.userDataDir,
      'account-2',
      '',
      '{"account":"other"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: otherAccountHome,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      createStore(settings) as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    await service.removeAccount('account-1')

    expect(readFileSync(join(otherAccountHome, 'auth.json'), 'utf-8')).toBe('{"account":"other"}\n')
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-accounts] Refusing to remove untrusted managed home:',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('lists accounts with normalizeActiveSelection', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'nonexistent-id'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = service.listAccounts()

    expect(result.accounts).toHaveLength(1)
    expect(result.activeAccountId).toBe(null)
  })

  it('rejects paths that escape the managed accounts root', async () => {
    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.removeAccount('nonexistent')).rejects.toThrow('no longer exists')
  })

  it('serializes concurrent mutations', async () => {
    const managedHomePath = createManagedHome(
      testState.userDataDir,
      'account-1',
      '',
      '{"account":"managed"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })
    const store = createStore(settings)
    const callOrder: string[] = []
    const rateLimits = {
      refreshForCodexAccountChange: vi.fn(async () => {
        callOrder.push('refresh')
      }),
      evictInactiveCodexCache: vi.fn()
    }
    const runtimeHome = createRuntimeHome()

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const p1 = service.selectAccount('account-1')
    const p2 = service.selectAccount(null)
    await Promise.all([p1, p2])

    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(2)
  })
})
