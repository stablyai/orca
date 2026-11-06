import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createCodexAuthJson,
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))
beforeEach(() => {
  loginStatusProbeMock.read.mockReset()
  loginStatusProbeMock.refresh.mockReset()
  loginStatusProbeMock.refreshIfStale.mockReset()
})

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const loginStatusProbeMock = vi.hoisted(() => ({
  read: vi.fn<() => { authenticated: boolean; authKind: 'oauth' | 'api-key' | 'none' } | null>(),
  refresh:
    vi.fn<
      () => Promise<{ authenticated: boolean; authKind: 'oauth' | 'api-key' | 'none' } | null>
    >(),
  refreshIfStale: vi.fn<() => void>()
}))

vi.mock('./codex-cli-login-status', () => ({
  systemDefaultCodexLoginStatus: loginStatusProbeMock
}))

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

    it('reports a signed-in system default when a keyring credential store holds the login', async () => {
      writeFileSync(
        join(systemCodexHomeDir(), 'config.toml'),
        'cli_auth_credentials_store = "keyring"\n',
        'utf-8'
      )
      loginStatusProbeMock.read.mockReturnValue({ authenticated: true, authKind: 'oauth' })
      const service = await newService()

      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(state.systemDefault).toEqual({
        hasAuth: true,
        authKind: 'oauth',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })

    it('awaits the login-status probe for keyring-backed system defaults before listing', async () => {
      writeFileSync(
        join(systemCodexHomeDir(), 'config.toml'),
        'cli_auth_credentials_store = "auto"\n',
        'utf-8'
      )
      loginStatusProbeMock.read.mockReturnValue(null)
      loginStatusProbeMock.refresh.mockImplementation(async () => {
        // A real refresh updates the cache that sync snapshots read.
        loginStatusProbeMock.read.mockReturnValue({ authenticated: true, authKind: 'oauth' })
        return { authenticated: true, authKind: 'oauth' }
      })
      const service = await newService()

      await withoutEnvApiKey(async () => service.refreshSystemDefaultSignIn())
      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(loginStatusProbeMock.refresh).toHaveBeenCalledTimes(1)
      expect(state.systemDefault).toMatchObject({ hasAuth: true, authKind: 'oauth' })
    })

    it('consults the configured store when auth.json exists but cannot establish a login', async () => {
      writeFileSync(
        join(systemCodexHomeDir(), 'config.toml'),
        'cli_auth_credentials_store = "keyring"\n',
        'utf-8'
      )
      writeFileSync(systemAuthPath(), 'null', 'utf-8')
      loginStatusProbeMock.read.mockReturnValue({ authenticated: true, authKind: 'oauth' })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const service = await newService()

      try {
        await withoutEnvApiKey(async () => service.refreshSystemDefaultSignIn())
        const state = withoutEnvApiKey(() => service.listAccounts())

        expect(loginStatusProbeMock.refresh).toHaveBeenCalledTimes(1)
        expect(state.systemDefault).toMatchObject({ hasAuth: true, authKind: 'oauth' })
      } finally {
        warn.mockRestore()
      }
    })

    it('never consults the CLI while credentials stay in auth.json', async () => {
      writeFileSync(
        join(systemCodexHomeDir(), 'config.toml'),
        'cli_auth_credentials_store = "keyring"\n',
        'utf-8'
      )
      writeFileSync(
        systemAuthPath(),
        createCodexAuthJson('file@home.dev', 'acct-file', 'refresh-file'),
        'utf-8'
      )
      const service = await newService()

      await withoutEnvApiKey(async () => service.refreshSystemDefaultSignIn())
      const state = withoutEnvApiKey(() => service.listAccounts())

      expect(loginStatusProbeMock.refresh).not.toHaveBeenCalled()
      expect(state.systemDefault).toMatchObject({ hasAuth: true, email: 'file@home.dev' })
    })
  })
})
