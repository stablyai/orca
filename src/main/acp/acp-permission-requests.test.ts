import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'

import type { RequestPermissionRequest } from './generated/acp-protocol.generated'

const opened: { close: () => void }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const allow = { optionId: 'allow', name: 'Allow', kind: 'allow_once' }
const toolCall = { toolCallId: 'tool-1', title: 'Edit file' }
function fixture(options: AcpSessionRuntimeOptions = {}) {
  const agent = new AcpScriptedAgent()
  const diagnostics: string[] = []
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, {
    onDiagnostic: (message) => diagnostics.push(message),
    ...options
  })
  opened.push(agent, runtime)
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  agent.on('session/prompt', () => {})
  return { agent, runtime, diagnostics }
}
afterEach(() =>
  opened
    .splice(0)
    .toReversed()
    .forEach((resource) => resource.close())
)

describe('ACP permission requests', () => {
  it('lets the owner decline a permission after cancel, before the handler starts', async () => {
    let stopping = false
    const asked = vi.fn((_request: RequestPermissionRequest) => ({
      outcome: stopping
        ? { outcome: 'cancelled' as const }
        : { outcome: 'selected' as const, optionId: 'allow' }
    }))
    const { agent, runtime } = fixture({ onPermission: asked })
    await runtime.start(startOptions)
    runtime.subscribe(() => {
      stopping = true
      void runtime.cancel()
    })
    const answer = new Promise<unknown>((resolve) => {
      agent.stdin.on('data', (chunk: string) => {
        if (chunk.includes('"id":5')) {
          resolve(JSON.parse(chunk))
        }
      })
    })
    // One chunk: the permission, then an update whose listener cancels before the handler runs.
    agent.stdout.write(
      [
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'session/request_permission',
          params: { sessionId: 'session-1', toolCall, options: [allow] }
        },
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }
          }
        }
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join('')
    )
    expect(await answer).toMatchObject({ id: 5, result: { outcome: { outcome: 'cancelled' } } })
    expect(stopping).toBe(true)
    expect(asked).toHaveBeenCalledOnce()
  })

  it('keeps an autonomous permission with its owner after session/cancel', async () => {
    const decision = deferred<{ outcome: { outcome: 'cancelled' } }>()
    const asked = deferred<AbortSignal>()
    const { agent, runtime } = fixture({
      onPermission: (_request, context) => {
        asked.resolve(context.signal)
        return decision.promise
      }
    })
    await runtime.start(startOptions)
    const answer = agent.request('p', 'session/request_permission', {
      sessionId: 'session-1',
      toolCall,
      options: [allow]
    })
    const signal = await asked.promise
    await runtime.cancel()
    expect(signal.aborted).toBe(false)
    decision.resolve({ outcome: { outcome: 'cancelled' } })
    expect(await answer).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    await tick()
    expect(agent.frames.filter((frame) => frame.method === 'session/cancel')).toHaveLength(1)
  })
})
