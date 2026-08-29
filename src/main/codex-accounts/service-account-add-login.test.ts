import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { CodexRateLimitAccountsState } from '../../shared/managed-account-types'
import type { readHookTrustEntries as ReadHookTrustEntries } from '../codex/config-toml-trust'
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
import { createCanonicalHookTrustFixture } from './service-hook-trust-test-fixtures'

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

  it('seeds the managed home config before codex login runs', async () => {
    vi.resetModules()

    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig =
      'model_provider = "openai"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')

    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()

        const loginHome = options.env.CODEX_HOME
        expect(loginHome).toBeTruthy()
        expect(readFileSync(join(loginHome!, 'config.toml'), 'utf-8')).toBe(canonicalConfig)

        const payload = Buffer.from(JSON.stringify({ email: 'user@example.com' })).toString(
          'base64url'
        )
        writeFileSync(
          join(loginHome!, 'auth.json'),
          JSON.stringify({
            tokens: {
              id_token: `header.${payload}.signature`
            }
          }),
          'utf-8'
        )

        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

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

    await service.addAccount()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(1)
    // Why: the desktop add path must pass the new account's selection target, as
    // reauthenticate and select already do. Called with no argument, a WSL add
    // syncs the host home that did not change and never materializes the WSL
    // slot that did.
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
  })

  it('does not seed source-home hook trust when adding a self-contained account', async () => {
    vi.resetModules()
    let fixture: Awaited<ReturnType<typeof createCanonicalHookTrustFixture>>
    let readHookTrustEntries: typeof ReadHookTrustEntries
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()

        const loginHome = options.env.CODEX_HOME
        expect(loginHome).toBeTruthy()
        const entries = readHookTrustEntries(join(loginHome!, 'config.toml'))
        for (const key of fixture.orcaKeys) {
          expect(entries.has(key)).toBe(false)
        }
        expect(entries.has(fixture.userKey)).toBe(false)
        writeFileSync(
          join(loginHome!, 'auth.json'),
          createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
          'utf-8'
        )

        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))
    fixture = await createCanonicalHookTrustFixture()
    readHookTrustEntries = (await import('../codex/config-toml-trust')).readHookTrustEntries
    writeFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), fixture.config, 'utf-8')

    const store = createStore(createSettings())
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await service.addAccount()

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('rejects OAuth account add when canonical config pins a custom provider', async () => {
    vi.resetModules()

    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = [
      'model_provider = "codex-lb"',
      'model = "gpt-5.2-codex"',
      '',
      '[model_providers.codex-lb]',
      'name = "Codex load balancer"',
      'base_url = "https://codex-lb.example.test/v1"',
      'env_key = "CODEX_LB_API_KEY"',
      ''
    ].join('\n')
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')

    const spawnMock = vi.fn()
    vi.doMock('node:crypto', () => ({ randomUUID: () => 'account-id-for-test' }))
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))

    try {
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

      await expect(service.addAccount()).rejects.toThrow(
        'Orca cannot add a Codex OAuth account while ~/.codex/config.toml pins the custom provider "codex-lb". Keep using the system-default account for this provider, or remove model_provider (or set it to "openai") before adding an OAuth account. Orca left your config unchanged.'
      )

      expect(spawnMock).not.toHaveBeenCalled()
      expect(store.updateSettings).not.toHaveBeenCalled()
      expect(runtimeHome.syncForCurrentSelection).not.toHaveBeenCalled()
      expect(existsSync(join(testState.userDataDir, 'codex-accounts', 'account-id-for-test'))).toBe(
        false
      )
      expect(readFileSync(canonicalConfigPath, 'utf-8')).toBe(canonicalConfig)
    } finally {
      vi.doUnmock('node:crypto')
      vi.doUnmock('node:child_process')
    }
  })

  it('recreates the expected missing managed home before reauthenticating', async () => {
    vi.resetModules()

    const canonicalConfigPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    const canonicalConfig = 'sandbox_mode = "danger-full-access"\n'
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')

    const managedHomePath = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const loginHome = options.env.CODEX_HOME
        expect(loginHome).toBeTruthy()
        expect(readFileSync(join(loginHome!, '.orca-managed-home'), 'utf-8')).toBe('account-1\n')
        expect(readFileSync(join(loginHome!, 'config.toml'), 'utf-8')).toBe(canonicalConfig)

        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()
        writeFileSync(
          join(loginHome!, 'auth.json'),
          createCodexAuthJson('new@example.com', 'provider-account-1', 'refresh-token'),
          'utf-8'
        )
        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    const result = await service.reauthenticateAccount('account-1')

    expect(result.accounts[0]).toMatchObject({
      email: 'new@example.com',
      providerAccountId: 'provider-account-1'
    })
    expect(existsSync(managedHomePath)).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it.each([
    {
      label: 'the active account',
      accountId: 'account-1',
      outcome: 'success',
      expectedActiveAccountId: 'account-1',
      expectedUpdateCount: 2
    },
    {
      label: 'a different account',
      accountId: 'account-2',
      outcome: 'success',
      expectedActiveAccountId: 'account-1',
      expectedUpdateCount: 2
    },
    {
      label: 'a login that fails',
      accountId: 'account-1',
      outcome: 'login-failure',
      expectedActiveAccountId: null,
      expectedUpdateCount: 1
    },
    {
      label: 'credentials rejected by runtime validation',
      accountId: 'account-1',
      outcome: 'runtime-validation-failure',
      expectedActiveAccountId: null,
      expectedUpdateCount: 3
    }
  ])('keeps host selection semantics when reauthenticating $label', async (testCase) => {
    vi.resetModules()

    const hostAccounts = ['account-1', 'account-2'].map((id, index) => ({
      id,
      email: `${id}@example.com`,
      managedHomePath: createManagedHome(
        testState.userDataDir,
        id,
        '',
        createCodexAuthJson(`${id}@example.com`, `provider-${id}`, `refresh-${id}`)
      ),
      providerAccountId: `provider-${id}`,
      workspaceLabel: null,
      workspaceAccountId: `provider-${id}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      lastAuthenticatedAt: index + 1
    }))
    const wslAccount = {
      id: 'account-wsl',
      email: 'account-wsl@example.com',
      managedHomePath: createManagedHome(
        testState.userDataDir,
        'account-wsl',
        '',
        createCodexAuthJson('account-wsl@example.com', 'provider-wsl', 'refresh-wsl')
      ),
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      wslLinuxHomePath: '/home/test/.local/share/orca/codex-accounts/account-wsl/home',
      providerAccountId: 'provider-wsl',
      workspaceLabel: null,
      workspaceAccountId: 'provider-wsl',
      createdAt: 3,
      updatedAt: 3,
      lastAuthenticatedAt: 3
    }
    const settings = createSettings({
      codexManagedAccounts: [...hostAccounts, wslAccount],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'account-wsl' }
      }
    })
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()
        const current = store.getSettings()
        store.updateSettings({
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: {
            ...current.activeCodexManagedAccountIdsByRuntime!,
            host: null,
            wsl: { Ubuntu: null }
          }
        })
        if (testCase.outcome === 'login-failure') {
          queueMicrotask(() => child.emit('close', 1))
          return child
        }
        writeFileSync(
          join(options.env.CODEX_HOME!, 'auth.json'),
          createCodexAuthJson('reauthenticated@example.com', 'provider-new', 'refresh-new'),
          'utf-8'
        )
        queueMicrotask(() => child.emit('close', 0))
        return child
      }
    )
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    runtimeHome.syncForCurrentSelection.mockImplementation(() => {
      if (testCase.outcome !== 'runtime-validation-failure') {
        return
      }
      const current = store.getSettings()
      store.updateSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: {
          ...current.activeCodexManagedAccountIdsByRuntime!,
          host: null
        }
      })
    })
    const rateLimits = createRateLimits()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    let result: CodexRateLimitAccountsState | null = null
    if (testCase.outcome === 'login-failure') {
      await expect(service.reauthenticateAccount(testCase.accountId)).rejects.toThrow(
        'Codex login exited with code 1.'
      )
    } else {
      result = await service.reauthenticateAccount(testCase.accountId)
    }

    expect(result?.activeAccountId ?? null).toBe(testCase.expectedActiveAccountId)
    if (result) {
      expect(result.activeAccountIdsByRuntime).toEqual({
        host: testCase.expectedActiveAccountId,
        wsl: { Ubuntu: null }
      })
    }
    expect(store.getSettings()).toMatchObject({
      activeCodexManagedAccountId: testCase.expectedActiveAccountId,
      activeCodexManagedAccountIdsByRuntime: {
        host: testCase.expectedActiveAccountId,
        wsl: { Ubuntu: null }
      }
    })
    const completedLogin = testCase.outcome !== 'login-failure'
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(completedLogin ? 1 : 0)
    if (completedLogin) {
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledWith(undefined, {
        runtime: 'host'
      })
    }
    expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(completedLogin ? 1 : 0)
    expect(store.updateSettings).toHaveBeenCalledTimes(testCase.expectedUpdateCount)
  })

  it('does not recreate a missing managed home at a different account path', async () => {
    vi.resetModules()
    const managedHomePath = join(testState.userDataDir, 'codex-accounts', 'other-account', 'home')
    const expectedManagedHomePath = join(
      testState.userDataDir,
      'codex-accounts',
      'account-1',
      'home'
    )
    const spawnMock = vi.fn()

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))

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
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'Managed Codex home directory does not exist on disk.'
    )
    expect(existsSync(expectedManagedHomePath)).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not trust an existing managed home that is missing its ownership marker', async () => {
    vi.resetModules()
    const managedHomePath = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(managedHomePath, { recursive: true })
    const spawnMock = vi.fn()

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))

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
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      store as never,
      rateLimits as never,
      runtimeHome as never
    )

    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'Managed Codex home is missing Orca ownership marker.'
    )
    expect(spawnMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
