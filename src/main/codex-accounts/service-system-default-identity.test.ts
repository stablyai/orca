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

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
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

    it('recognizes Bedrock Runtime without an auth.json file', async () => {
      writeFileSync(
        join(systemCodexHomeDir(), 'config.toml'),
        'model_provider = "amazon-bedrock-runtime"\n',
        'utf-8'
      )
      const service = await newService()

      expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault).toEqual({
        hasAuth: false,
        authKind: 'api-key',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })

    it('does not attribute Bedrock Mantle to a saved ChatGPT login', async () => {
      writeFileSync(
        join(systemCodexHomeDir(), 'config.toml'),
        'model_provider = "amazon-bedrock"\n',
        'utf-8'
      )
      writeFileSync(systemAuthPath(), createCodexAuthJson('old@home.dev', 'old', 'refresh'))
      const service = await newService()

      expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault).toEqual({
        hasAuth: true,
        authKind: 'api-key',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })

      writeFileSync(join(systemCodexHomeDir(), 'config.toml'), 'model_provider = "openai"\n')
      expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault).toEqual({
        hasAuth: true,
        authKind: 'oauth',
        email: 'old@home.dev',
        providerAccountId: 'old',
        workspaceLabel: null
      })
    })

    it('recognizes a saved Bedrock API key instead of reporting OAuth', async () => {
      writeFileSync(
        systemAuthPath(),
        JSON.stringify({
          auth_mode: 'bedrockApiKey',
          bedrock_api_key: { api_key: 'bedrock-test-key', region: 'us-east-2' }
        })
      )
      const service = await newService()

      expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault).toEqual({
        hasAuth: true,
        authKind: 'api-key',
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
  })
})
