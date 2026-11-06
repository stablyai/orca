import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  createCodexAuthJson,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

// Keep asserted config bytes independent of platform socket-path limits.
vi.mock(
  '../codex/configuration/shared-server/codex-daemon-socket-path-guard',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    applyCodexDaemonSocketGuard: (config: string) => config
  })
)

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
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
      // The teardown process-table reader binds execFile during module initialization.
      execFile: vi.fn(),
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

    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
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
      'env_key = "EXAMPLE_GATEWAY_TOKEN"',
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
        expect(loginHome).toMatch(/[\\/]account-1[\\/]home[\\/]\.orca-reauth-login$/)
        expect(readFileSync(join(managedHomePath, '.orca-managed-home'), 'utf-8')).toBe(
          'account-1\n'
        )
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
      // The teardown process-table reader binds execFile during module initialization.
      execFile: vi.fn(),
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
})
