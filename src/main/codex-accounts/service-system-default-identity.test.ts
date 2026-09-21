import { describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
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

  describe('system-default identity', () => {
    const systemCodexHomeDir = () => join(testState.fakeHomeDir, '.codex')
    const systemAuthPath = () => join(systemCodexHomeDir(), 'auth.json')

    async function newService() {
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      return new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)
    }

    function withoutEnvApiKey<T>(run: () => T): T {
      const previous = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      try {
        return run()
      } finally {
        if (previous === undefined) {
          delete process.env.OPENAI_API_KEY
        } else {
          process.env.OPENAI_API_KEY = previous
        }
      }
    }

    it('reports the real ~/.codex OAuth identity for the system default', async () => {
      writeFileSync(
        systemAuthPath(),
        createCodexAuthJson('real@home.dev', 'acct-real', 'refresh-real'),
        'utf-8'
      )
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.activeAccountId).toBeNull()
      expect(state.systemDefault).toEqual({
        hasAuth: true,
        authKind: 'oauth',
        email: 'real@home.dev',
        providerAccountId: 'acct-real',
        workspaceLabel: null
      })
    })

    it('reports an api-key auth.json as a custom provider with no identity', async () => {
      writeFileSync(systemAuthPath(), JSON.stringify({ OPENAI_API_KEY: 'sk-live-test' }), 'utf-8')
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.systemDefault).toEqual({
        hasAuth: true,
        authKind: 'api-key',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })

    it('reports signed-out when no auth.json and no env key is present', async () => {
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.systemDefault).toEqual({
        hasAuth: false,
        authKind: 'none',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })

    it('degrades safely when auth.json contains valid JSON with the wrong shape', async () => {
      writeFileSync(systemAuthPath(), 'null', 'utf-8')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const service = await newService()

      try {
        const state = withoutEnvApiKey(() => service.listAccounts())

        expect(state.systemDefault).toEqual({
          hasAuth: true,
          authKind: 'none',
          email: null,
          providerAccountId: null,
          workspaceLabel: null
        })
        expect(warn).toHaveBeenCalledWith(
          '[codex-accounts] System-default Codex auth has an unexpected format'
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('fails a corrupt managed auth.json without echoing credential bytes', async () => {
      const secret = 'sk-managed-secret-never-log'
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        '',
        `{"tokens": {"refresh_token": "${secret}"`
      )
      const service = await newService()

      let thrown: Error | null = null
      try {
        ;(
          service as unknown as {
            readIdentityFromHome(managedHomePath: string, expectedAccountId: string): unknown
          }
        ).readIdentityFromHome(managedHomePath, 'account-1')
      } catch (error) {
        thrown = error as Error
      }

      expect(thrown).not.toBeNull()
      expect(thrown!.message).toBe('Codex auth.json is corrupt or not valid JSON')
      expect(thrown!.message).not.toContain(secret)
    })

    it('does not log auth contents when auth.json is malformed', async () => {
      const secret = 'sk-secret-review-never-log'
      writeFileSync(systemAuthPath(), secret, 'utf-8')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const service = await newService()

      try {
        const state = withoutEnvApiKey(() => service.listAccounts())

        expect(state.systemDefault?.authKind).toBe('none')
        expect(warn).toHaveBeenCalledWith(
          '[codex-accounts] System-default Codex auth is not valid JSON'
        )
        expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
      } finally {
        warn.mockRestore()
      }
    })

    it('reports an env OPENAI_API_KEY (no auth.json) as a custom provider', async () => {
      const service = await newService()
      const previous = process.env.OPENAI_API_KEY
      process.env.OPENAI_API_KEY = 'sk-env-test'
      try {
        const state = service.listAccounts()
        expect(state.systemDefault).toEqual({
          hasAuth: false,
          authKind: 'api-key',
          email: null,
          providerAccountId: null,
          workspaceLabel: null
        })
      } finally {
        if (previous === undefined) {
          delete process.env.OPENAI_API_KEY
        } else {
          process.env.OPENAI_API_KEY = previous
        }
      }
    })

    it('never mutates ~/.codex when selecting or deselecting a managed account', async () => {
      const systemAuth = createCodexAuthJson('real@home.dev', 'acct-real', 'refresh-real')
      writeFileSync(systemAuthPath(), systemAuth, 'utf-8')
      const managedHomePath = createManagedHome(
        testState.userDataDir,
        'account-1',
        'approval_policy = "on-request"\n',
        createCodexAuthJson('managed@example.com', 'acct-managed', 'refresh-managed')
      )
      const store = createStore(
        createSettings({
          codexManagedAccounts: [
            {
              id: 'account-1',
              email: 'managed@example.com',
              managedHomePath,
              providerAccountId: 'acct-managed',
              workspaceLabel: null,
              workspaceAccountId: 'acct-managed',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await service.selectAccount('account-1')
      await service.selectAccount(null)

      expect(readFileSync(systemAuthPath(), 'utf-8')).toBe(systemAuth)
      const state = withoutEnvApiKey(() => service.listAccounts())
      expect(state.systemDefault?.email).toBe('real@home.dev')
    })
  })
})
