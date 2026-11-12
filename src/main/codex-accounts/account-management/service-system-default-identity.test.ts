import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { writeFileSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import '../../../renderer/src/components/settings/accounts/codex/codex-account-auth-warning'
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

const configWork = vi.hoisted(() => ({ readPaths: new Array<unknown>(), parses: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      configWork.readPaths.push(args[0])
      return actual.readFileSync(...args)
    }
  }
})

vi.mock(
  import('../../codex/structured/launch/codex-model-provider-config'),
  async (importOriginal) => {
    const actual = await importOriginal()
    return {
      ...actual,
      readCodexTopLevelModelProvider: (
        ...args: Parameters<typeof actual.readCodexTopLevelModelProvider>
      ) => {
        configWork.parses += 1
        return actual.readCodexTopLevelModelProvider(...args)
      }
    }
  }
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

  describe('system-default identity', () => {
    const systemCodexHomeDir = () => join(testState.fakeHomeDir, '.codex')
    const systemAuthPath = () => join(systemCodexHomeDir(), 'auth.json')

    async function newService() {
      const store = createStore(createSettings())
      const rateLimits = createRateLimits()
      const runtimeHome = createRuntimeHome()
      const { CodexAccountService } = await import('../service')
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

    it.each(['bedrockApiKey', undefined])(
      'recognizes a saved Bedrock API key with mode %s instead of reporting OAuth',
      async (mode) => {
        writeFileSync(
          systemAuthPath(),
          JSON.stringify({
            ...JSON.parse(createCodexAuthJson('old@home.dev', 'old', 'refresh')),
            auth_mode: mode,
            bedrock_api_key: { api_key: 'bedrock-fixture-key', region: 'us-east-2' }
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
      }
    )

    it('keeps backend auth status without attributing stale tokens to a personal access token', async () => {
      writeFileSync(
        systemAuthPath(),
        JSON.stringify({
          ...JSON.parse(createCodexAuthJson('old@home.dev', 'old', 'refresh')),
          personal_access_token: 'fixture-personal-access-token'
        })
      )
      const service = await newService()

      expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault).toEqual({
        hasAuth: true,
        authKind: 'oauth',
        email: null,
        providerAccountId: null,
        workspaceLabel: null
      })
    })
  })
})
