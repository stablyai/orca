import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { describe, expect, it, vi } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'
import { resolveCodexStructuredInvocation } from './codex-structured-launch-resolution'
import { runCodexAppServerSession, type CodexAppServerInvocation } from './codex-app-server-session'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'

const MODEL_ROW = {
  model: 'gpt-live',
  displayName: 'GPT Live',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  isDefault: true
}

describe('codex model catalog probe', () => {
  it.each([`"${process.execPath}"`, ''])(
    'lists with the session executable for Command %j',
    async (command) => {
      // The env a user's shell/config resolves for sessions, PATH included.
      const resolveEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
        PATH: '/resolved/bin',
        HOME: '/homes/user',
        OPENAI_BASE_URL: 'https://gateway.example',
        DROPPED: undefined
      })
      const resolveCommand = vi.fn((options?: { pathEnv?: string | null; homePath?: string }) => {
        expect(options?.pathEnv).toBe('/resolved/bin')
        expect(options?.homePath).toBe('/homes/user')
        return resolveStructuredAgentCommand(
          'codex',
          {
            agentCmdOverrides: { codex: command }
          },
          options
        )
      })
      const invocations: CodexAppServerInvocation[] = []
      const probe = createCodexModelCatalogProbe({
        resolveEnvironment,
        resolveCommand,
        runSession: async (invocation, body) => {
          invocations.push(invocation)
          return body({
            request: async () => ({ data: [MODEL_ROW], nextCursor: null }),
            notify: () => {}
          })
        }
      })
      const success = await probe({ variable: 'CODEX_HOME', path: '/homes/account-a' })
      expect(success.origin).toBe('probe')
      expect(success.models.map((model) => model.id)).toEqual(['gpt-live'])
      // The session launch resolves the exact same invocation for the same deps.
      const sessionInvocation = await resolveCodexStructuredInvocation({
        resolveEnvironment,
        resolveCommand
      })
      expect(invocations).toHaveLength(1)
      expect(invocations[0]!.cliPath).toBe(sessionInvocation.command)
      expect(invocations[0]!.env).toEqual({
        PATH: '/resolved/bin',
        HOME: '/homes/user',
        OPENAI_BASE_URL: 'https://gateway.example',
        CODEX_HOME: '/homes/account-a'
      })
      // A short-lived probe must not start plugin marketplace clones that outlive its teardown.
      expect(invocations[0]!.args.join(' ')).toContain('features.plugins=false')
    }
  )

  it('keeps the listing when config/read never answers', async () => {
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number' || message.method === 'config/read') return
        const result = message.method === 'model/list'
          ? { data: [${JSON.stringify(MODEL_ROW)}], nextCursor: null }
          : {}
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => '/bin/codex',
      // Real transport against a fake server; a session deadline shorter than the
      // production one keeps the test fast while still outliving config/read's bound.
      runSession: (invocation, body) =>
        runCodexAppServerSession(
          {
            ...invocation,
            command: process.execPath,
            cliPath: null,
            args: ['-e', server],
            timeoutMs: 6_000
          },
          body
        )
    })
    const success = await probe({ variable: 'CODEX_HOME', path: '/homes/a' })
    expect(success.models.map((model) => ({ id: model.id, isDefault: model.isDefault }))).toEqual([
      { id: 'gpt-live', isDefault: true }
    ])
  }, 10_000)

  it('refuses an empty listing rather than reporting it as a catalog', async () => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => '/bin/codex',
      runSession: async (_invocation, body) =>
        body({ request: async () => ({ data: [], nextCursor: null }), notify: () => {} })
    })
    await expect(probe({ variable: 'CODEX_HOME', path: '/homes/a' })).rejects.toThrow(
      /listed no models/
    )
  })

  it.each(['npx codex', 'codex --profile work', '/missing/codex', './codex'])(
    'lists nothing, and never probes the stock CLI, for Command %s',
    async (command) => {
      const runSession = vi.fn()
      const probe = createCodexModelCatalogProbe({
        resolveEnvironment: async () => ({ PATH: '/bin' }),
        resolveCommand: (options) =>
          resolveStructuredAgentCommand(
            'codex',
            { agentCmdOverrides: { codex: command } },
            options
          ),
        runSession
      })
      await expect(probe({ variable: 'CODEX_HOME', path: '/homes/a' })).rejects.toMatchObject({
        reason: 'agentCommandNotRunnable'
      })
      expect(runSession).not.toHaveBeenCalled()
    }
  )
})

describe('Codex catalog availability', () => {
  function withAccount(account: unknown) {
    return createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      // A stand-in system home, so no test reads the real ~/.codex/auth.json.
      resolveAccountKind: (home) => (home === '/homes/system' ? 'system' : 'managed'),
      runSession: async (_invocation, body) =>
        body({
          request: async (method, params, options) => {
            if (method === 'account/read') {
              expect(params).toEqual({ refreshToken: false })
              expect(options?.timeoutMs).toBe(2000)
              if (account instanceof Error) {
                throw account
              }
              return account
            }
            return { data: [MODEL_ROW], nextCursor: null }
          },
          notify: () => {}
        })
    })
  }
  it.each([
    null,
    {},
    { account: null },
    { requiresOpenaiAuth: true },
    { account: null, requiresOpenaiAuth: false },
    { account: {}, requiresOpenaiAuth: true },
    { account: null, requiresOpenaiAuth: 'true' },
    new Error('unsupported method'),
    new Error('timeout')
  ])('unknown or authenticated account does not block: %j', async (account) => {
    expect(
      (await withAccount(account)({ variable: 'CODEX_HOME', path: '/homes/a' })).models
    ).toHaveLength(1)
  })
  it.each([
    ['/homes/a', 'managed'],
    ['/homes/system', 'system']
  ] as const)(
    'reports explicit signed-out account for %s beside its list',
    async (home, account) => {
      // The verdict can be wrong while a chat works, so the picker keeps the list it got.
      expect(
        await withAccount({ account: null, requiresOpenaiAuth: true })({
          variable: 'CODEX_HOME',
          path: home
        })
      ).toMatchObject({
        models: [{ id: 'gpt-live' }],
        unavailable: { reason: 'notSignedIn', account }
      })
    }
  )
  it('omits unknown account context from a positive signed-out fact', async () => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      runSession: async (_invocation, body) =>
        body({
          request: async (method) =>
            method === 'account/read'
              ? { account: null, requiresOpenaiAuth: true }
              : { data: [MODEL_ROW], nextCursor: null },
          notify: () => {}
        })
    })
    expect((await probe({ variable: 'CODEX_HOME', path: '/custom/home' })).unavailable).toEqual({
      reason: 'notSignedIn'
    })
  })
  it('lists models while the account check is still answering', async () => {
    let answerAccount!: (value: unknown) => void
    const methods: string[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      runSession: async (_invocation, body) =>
        body({
          request: async (method) => {
            methods.push(method)
            if (method === 'account/read') {
              return new Promise((resolve) => (answerAccount = resolve))
            }
            return { data: [MODEL_ROW], nextCursor: null }
          },
          notify: () => {}
        })
    })
    const pending = probe({ variable: 'CODEX_HOME', path: '/homes/a' })
    await vi.waitFor(() => expect(methods).toContain('model/list'))
    expect(methods).toContain('account/read')
    answerAccount({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
    expect((await pending).models).toHaveLength(1)
  })
  it('a signed-out verdict wins over a model listing that failed', async () => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      runSession: async (_invocation, body) =>
        body({
          request: async (method) => {
            if (method === 'account/read') {
              return { account: null, requiresOpenaiAuth: true }
            }
            throw new Error('401 Unauthorized')
          },
          notify: () => {}
        })
    })
    await expect(probe({ variable: 'CODEX_HOME', path: '/homes/a' })).rejects.toMatchObject({
      unavailable: { reason: 'notSignedIn' }
    })
  })
  it.each(['ENOENT', 'EACCES'])('classifies only missing executable errors: %s', async (code) => {
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      runSession: async () => {
        throw Object.assign(new Error('spawn failed'), { code, path: 'codex' })
      }
    })
    const failure = await probe({ variable: 'CODEX_HOME', path: '/homes/a' }).catch(
      (error: unknown) => error
    )
    expect(failure instanceof AgentModelCatalogUnavailableError).toBe(code === 'ENOENT')
  })
})

describe('Codex catalog probe reads the home a launch would', () => {
  it('runs the launch sync on the home before its app-server reads it', async () => {
    const order: string[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      prepareHome: (prepared) => order.push(`prepare ${prepared}`),
      runSession: async (_invocation, body) => {
        order.push('spawn')
        return body({
          request: async (method) =>
            method === 'account/read'
              ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
              : { data: [MODEL_ROW], nextCursor: null },
          notify: () => {}
        })
      }
    })
    expect((await probe({ variable: 'CODEX_HOME', path: '/homes/mirror' })).models).toHaveLength(1)
    expect(order).toEqual(['prepare /homes/mirror', 'spawn'])
  })
})
