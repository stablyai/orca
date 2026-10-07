import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { getDshStatusPluginSource } from './status-plugin-source'

const binary = process.env.ORCA_REAL_DSH_CLI

// Opt-in published runtime check. All generations use localhost; no provider credentials.
describe.skipIf(!binary || process.platform === 'win32')(
  'native DSH lifecycle with mock LLM',
  () => {
    it('keeps child completion and Stop continuation out of root idle', async () => {
      if (!binary) {
        throw new Error('Set ORCA_REAL_DSH_CLI to the official dsh executable')
      }
      const root = await mkdtemp(join(tmpdir(), 'orca-dsh-native-'))
      let requests = 0
      const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
          requests++
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          for (const delta of [{ role: 'assistant' }, { content: 'OK' }]) {
            response.write(
              `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
            )
          }
          response.end(
            `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
          )
        })
      })
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('No mock server port')
        }
        const plugin = join(root, 'status.mjs')
        const control = join(root, 'control.mjs')
        // Emulate only the PTY output capability; actual TUI transport is checked separately.
        await writeFile(
          plugin,
          `Object.defineProperty(process.stdout, 'isTTY', { value: true })\n${getDshStatusPluginSource('true')}`
        )
        await writeFile(
          control,
          `
import { randomUUID } from 'node:crypto'
const message = text => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
export function apply(ctx) {
  let continued = false
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.session.header.parentSession || continued) return
    continued = true
    const child = await agent.ctx.agents.create({
      sessionId: randomUUID(), parentAgent: agent,
      meta: { cwd: agent.session.header.cwd, origin: 'subagent', parentSession: agent.session.header.id, delegationDepth: 1 },
      agentOptions: agent.options, signal: new AbortController().signal
    })
    child.agent.followup(message('Child reply OK'))
    await child.agent.whenIdle()
    agent.steer(message('Continue once'))
  })
}
`
        )
        const patch = join(root, 'patch.yml')
        await writeFile(
          patch,
          JSON.stringify([
            { id: 'agent-default-model', config: { provider: 'mock', model: 'mock' } },
            {
              id: 'llm-pi-ai',
              config: {
                providers: {
                  mock: {
                    api: 'openai-completions',
                    apiKeyEnv: 'ORCA_DSH_MOCK_KEY',
                    baseURL: `http://127.0.0.1:${address.port}/v1`,
                    models: [{ id: 'mock', contextWindow: 8192, maxTokens: 1024 }]
                  }
                }
              }
            },
            { id: 'session-title-llm', disabled: true },
            {
              insert: [
                { id: 'orca-status', name: plugin },
                { id: 'continuation-control', name: control }
              ]
            }
          ])
        )
        const result = await runProcess({
          program: binary,
          args: ['headless', '--patch', patch, 'Reply OK'],
          cwd: root,
          env: {
            ...process.env,
            DSH_HOME: join(root, 'home'),
            DEEPSEEK_API_KEY: '',
            ORCA_DSH_MOCK_KEY: 'test-key',
            ORCA_AGENT_PANE: 'isolated-test-pane',
            DSH_PERMISSION_MODE: 'danger-full-access'
          },
          timeoutMs: 30_000
        })
        expect(result.code, result.stderr).toBe(0)
        expect(result.stderr).not.toContain('failed')
        expect(requests).toBe(3)
        const prefix = `${String.fromCharCode(27)}]9999;`
        const frames = result.stdout
          .split(prefix)
          .slice(1)
          .map((chunk) => JSON.parse(chunk.split(String.fromCharCode(7))[0]))
        expect(frames).toEqual([
          { state: 'working', agentType: 'dsh' },
          { state: 'done', agentType: 'dsh' }
        ])
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }, 45_000)
  }
)
