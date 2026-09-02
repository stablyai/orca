import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  createCodexAuthJson,
  createManagedHome,
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

  // Why: quota probes against a cold per-account CODEX_HOME can take 10–25s
  // (RPC + PTY fallback) and queue behind an in-flight global usage refresh;
  // account mutations must never block on — or fail because of — that probe.
  describe('quota refresh decoupling', () => {
    function createAccountOneSettings(): GlobalSettings {
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        '',
        '{"account":"managed"}\n'
      )
      return createSettings({
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
    }

    async function expectResolvesPromptly<T>(promise: Promise<T>, label: string): Promise<T> {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} blocked on the quota refresh`)),
              2_000
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    function createLoginSpawnMock() {
      return vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough
          stderr: PassThrough
          kill: () => void
        }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = vi.fn()
        writeFileSync(
          join(options.env.CODEX_HOME!, 'auth.json'),
          createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
          'utf-8'
        )
        queueMicrotask(() => child.emit('close', 0))
        return child
      })
    }

    it('resolves selectAccount while the quota refresh never settles', async () => {
      const store = createStore(createAccountOneSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn(() => new Promise<never>(() => {})),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await expectResolvesPromptly(
        service.selectAccount('account-1'),
        'selectAccount'
      )

      expect(state.activeAccountId).toBe('account-1')
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(1)
    })

    it('resolves selectAccount when the quota refresh rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = createStore(createAccountOneSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn().mockRejectedValue(new Error('cold probe failed')),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await service.selectAccount('account-1')

      expect(state.activeAccountId).toBe('account-1')
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
      errorSpy.mockRestore()
    })

    it('resolves addAccount while the post-login quota refresh never settles', async () => {
      vi.resetModules()
      writeFileSync(
        join(testState.fakeHomeDir, '.codex', 'config.toml'),
        'approval_policy = "never"\n',
        'utf-8'
      )
      const spawnMock = createLoginSpawnMock()
      vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
      vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

      const store = createStore(createSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn(() => new Promise<never>(() => {})),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await expectResolvesPromptly(service.addAccount(), 'addAccount')

      expect(state.accounts).toHaveLength(1)
      expect(state.accounts[0].email).toBe('user@example.com')
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(1)
    })

    it('keeps the new account and its managed home when the post-login quota refresh rejects', async () => {
      vi.resetModules()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      writeFileSync(
        join(testState.fakeHomeDir, '.codex', 'config.toml'),
        'approval_policy = "never"\n',
        'utf-8'
      )
      const spawnMock = createLoginSpawnMock()
      vi.doMock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: spawnMock }))
      vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

      const store = createStore(createSettings())
      const rateLimits = {
        refreshForCodexAccountChange: vi.fn().mockRejectedValue(new Error('cold probe failed')),
        evictInactiveCodexCache: vi.fn()
      }
      const runtimeHome = createRuntimeHome()

      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const state = await service.addAccount()

      expect(state.accounts).toHaveLength(1)
      const account = store.getSettings().codexManagedAccounts[0]
      expect(account.email).toBe('user@example.com')
      // The durable mutation must survive a failed usage probe — previously the
      // rejection fell into login cleanup and deleted the just-created home.
      expect(existsSync(account.managedHomePath)).toBe(true)
      expect(existsSync(join(account.managedHomePath, 'auth.json'))).toBe(true)
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
      errorSpy.mockRestore()
    })
  })
})
