import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { rmSync, writeFileSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import { getCodexAccountAuthWarning } from '../../renderer/src/components/settings/accounts/codex/codex-account-auth-warning'
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
  import('../codex/structured/launch/codex-model-provider-config'),
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

    it.each(['amazon-bedrock-runtime', 'ollama'])(
      'recognizes %s without an auth.json file',
      async (provider) => {
        writeFileSync(
          join(systemCodexHomeDir(), 'config.toml'),
          `model_provider = "${provider}"\n`,
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
        expect(
          getCodexAccountAuthWarning({
            limits: null,
            target: { runtime: 'host', wslDistro: null },
            runtime: { runtime: 'host' },
            activeAccountId: null,
            accountId: null,
            authKind: withoutEnvApiKey(() => service.listAccounts()).systemDefault?.authKind
          })
        ).toBeNull()
      }
    )

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

    it.each([750, 7_500])(
      'reuses unchanged provider input across snapshots with %i saved projects',
      async (projectCount) => {
        const configPath = join(systemCodexHomeDir(), 'config.toml')
        const projects = Array.from(
          { length: projectCount },
          (_, index) => `[projects."/work/project-${index}"]\ntrust_level = "trusted"\n`
        ).join('')
        writeFileSync(configPath, `model_provider = "amazon-bedrock"\n${projects}`)
        writeFileSync(
          systemAuthPath(),
          createCodexAuthJson('real@home.dev', 'acct-real', 'refresh')
        )
        const service = await newService()
        configWork.readPaths = []
        configWork.parses = 0
        const configReads = () => configWork.readPaths.filter((path) => path === configPath).length

        for (let update = 0; update < 20; update += 1) {
          expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault?.authKind).toBe(
            'api-key'
          )
        }
        // Usage updates do not invalidate the one current provider classification.
        expect(configReads()).toBe(1)
        expect(configWork.parses).toBe(1)

        rmSync(configPath)
        expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault?.authKind).toBe('oauth')
        expect(configReads()).toBe(2)
        service.listAccounts()
        expect(configReads()).toBe(2)

        writeFileSync(configPath, `model_provider = "openai"\n${projects}`)
        expect(withoutEnvApiKey(() => service.listAccounts()).systemDefault).toEqual({
          hasAuth: true,
          authKind: 'oauth',
          email: 'real@home.dev',
          providerAccountId: 'acct-real',
          workspaceLabel: null
        })
        expect(configReads()).toBe(3)
        expect(configWork.parses).toBe(2)
      }
    )

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
