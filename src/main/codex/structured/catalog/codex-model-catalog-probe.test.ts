import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'
import {
  runCodexAppServerSession,
  type CodexAppServerInvocation
} from '../../app-server/codex-app-server-session'

const MODEL_ROW = {
  model: 'gpt-live',
  displayName: 'GPT Live',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  isDefault: true
}

afterEach(() => vi.unstubAllGlobals())

describe('codex model catalog probe', () => {
  it.each([
    [[], ['/orca-probe', '/orca-probe']],
    [['node_modules/@openai/codex/bin/codex.js'], ['/chat-a', '/chat-b']],
    [
      ['-c', 'model_instructions_file="./prompt.md"'],
      ['/chat-a', '/chat-b']
    ]
  ])('lists a command line with arguments %j from %j', async (prefixArgs, listedIn) => {
    // Only the plain CLI shares one listing; user arguments may name files in the chat's folder.
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
    expect(invocations.map((invocation) => invocation.cwd)).toEqual(listedIn)
    expect(invocations[0]?.args.slice(0, prefixArgs.length)).toEqual(prefixArgs)
    // A listing in the chat's folder never loads that folder's project config.
    expect(invocations[0]?.args.includes('projects={"/chat-a"={trust_level="untrusted"}}')).toBe(
      listedIn[0] === '/chat-a'
    )
    expect(invocations[0]?.args).toContain('project_root_markers=[]')
    expect(identities[0]).toMatchObject({ cwd: listedIn[0] })
    expect(JSON.stringify(identities[0]) === JSON.stringify(identities[1])).toBe(
      listedIn[0] === listedIn[1]
    )
    // The account's configured default is read for Orca's folder, never the project's.
    expect(configReads).toEqual(
      expect.arrayContaining([expect.objectContaining({ cwd: '/orca-probe' })])
    )
  })

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
})
