import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'
import {
  runCodexAppServerSession,
  type CodexAppServerInvocation
} from '../../app-server/codex-app-server-session'
import { resolveStructuredAgentCommand } from '../../../native-chat/structured-agent-command-resolution'

const MODEL_ROW = {
  model: 'gpt-live',
  displayName: 'GPT Live',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  isDefault: true
}

afterEach(() => vi.unstubAllGlobals())

it.each(['saved', 'recover'] as const)(
  'composes the Windows %s catalog environment before lookup and listing',
  async (lookup) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/inherited/bin', TOKEN: 'inherited' }),
      resolveSavedEnvironment: async () => ({ PATH: '/saved/bin', TOKEN: 'saved' }),
      resolveEnv: () => ({
        path: '/configured/bin',
        tOKEN: 'configured',
        codex_home: '/configured/home'
      }),
      resolveCommand: (options) => {
        expect(options?.pathEnv).toBe('/configured/bin')
        return { command: '/configured/bin/codex.exe', prefixArgs: [] }
      },
      runSession: async (invocation, body) => {
        expect(invocation.env).toEqual({
          PATH: '/configured/bin',
          TOKEN: 'configured',
          CODEX_HOME: '/pinned'
        })
        return body({
          request: async (method: string) =>
            method === 'config/read' ? { config: {} } : { data: [MODEL_ROW], nextCursor: null },
          notify: () => {}
        })
      }
    })
    const resolved = await probe.resolve?.(
      { variable: 'CODEX_HOME', path: '/pinned' },
      '/probe',
      lookup
    )
    expect((await resolved?.run())?.models[0]?.id).toBe('gpt-live')
  }
)

describe('codex model catalog probe', () => {
  it.each([[[]]])(
    "lists a command line with arguments %j from Orca's folder for every chat",
    async (prefixArgs) => {
      // The chat's repo never picks the list, so no listing runs in a chat's folder.
      const invocations: CodexAppServerInvocation[] = []
      const configReads: unknown[] = []
      const probe = createCodexModelCatalogProbe({
        resolveEnvironment: async () => ({ PATH: '/bin' }),
        resolveCommand: () => ({ command: '/bin/codex', prefixArgs }),
        runSession: async (invocation, body) => {
          invocations.push(invocation)
          return body({
            request: async (method: string, params: unknown) => {
              if (method === 'config/read') {
                configReads.push(params)
                return { config: {} }
              }
              return { data: [MODEL_ROW], nextCursor: null }
            },
            notify: () => {}
          })
        }
      })
      const identities: unknown[] = []
      for (const folder of ['/chat-a', '/chat-b']) {
        const resolved = await probe.resolve?.(
          { variable: 'CODEX_HOME', path: '/homes/a' },
          '/orca-probe',
          'snapshot',
          undefined,
          folder
        )
        identities.push(resolved?.identity)
        await resolved?.run()
      }
      expect(invocations.map((invocation) => invocation.cwd)).toEqual([
        '/orca-probe',
        '/orca-probe'
      ])
      expect(invocations[0]?.args.slice(0, prefixArgs.length + 2)).toEqual([
        ...prefixArgs,
        '-c',
        'project_root_markers=[]'
      ])
      expect(identities[0]).toMatchObject({ cwd: '/orca-probe' })
      expect(identities[1]).toEqual(identities[0])
      // The account's configured default is read for Orca's folder, never the project's.
      expect(configReads).toEqual(
        expect.arrayContaining([expect.objectContaining({ cwd: '/orca-probe' })])
      )
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
    const configReadTimeouts: (number | null | undefined)[] = []
    const configReadFailures: unknown[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/bin' }),
      resolveCommand: () => ({ command: '/bin/codex', prefixArgs: [] }),
      // Keep the real request timeout while checking the production budget below.
      runSession: (invocation, body) =>
        runCodexAppServerSession(
          {
            ...invocation,
            command: process.execPath,
            cliPath: null,
            args: ['-e', server],
            timeoutMs: 6_000
          },
          (rpc) =>
            body({
              ...rpc,
              request: async (method, params, options) => {
                if (method !== 'config/read') {
                  return rpc.request(method, params, options)
                }
                configReadTimeouts.push(options?.timeoutMs)
                try {
                  return await rpc.request(method, params, { ...options, timeoutMs: 20 })
                } catch (error) {
                  configReadFailures.push(error)
                  throw error
                }
              }
            })
        )
    })
    const success = await probe({ variable: 'CODEX_HOME', path: '/homes/a' })
    expect(success.complete).toBe(false)
    expect(configReadTimeouts).toEqual([3_000])
    expect(configReadFailures).toEqual([
      expect.objectContaining({
        name: 'CodexAppServerTimeoutError',
        message: 'codex app-server config/read exceeded 20ms'
      })
    ])
    expect(success.models.map((model) => ({ id: model.id, isDefault: model.isDefault }))).toEqual([
      { id: 'gpt-live', isDefault: true }
    ])
  }, 10_000)

  it.each(['launcher $SECRET codex', 'FOO=1 codex', '/missing/codex', './codex'])(
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
