import { describe, expect, it, vi } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { resolveStructuredAgentCommand } from '../../../native-chat/structured-agent-command-resolution'

const MODEL_ROW = {
  model: 'gpt-live',
  displayName: 'GPT Live',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  isDefault: true
}

describe('codex model catalog probe', () => {
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
