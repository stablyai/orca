import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessionRuntime, type AcpSessionEvent } from './acp-session-runtime'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'

const opened: { close: () => void }[] = []
function fixture() {
  const agent = new AcpScriptedAgent()
  const diagnostic = vi.fn()
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, { onDiagnostic: diagnostic })
  opened.push(agent, runtime)
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: 1, agentCapabilities: { vendor: true } })
  )
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1', vendor: true }))
  return { agent, runtime, diagnostic }
}
afterEach(() =>
  opened
    .splice(0)
    .toReversed()
    .forEach((resource) => resource.close())
)

describe('ACP session update compatibility', () => {
  it.each([
    ['known', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }],
    // Unfamiliar enum values stay typed: the generated enums are open.
    ['known', { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Search', kind: 'web_search' }],
    ['known', { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'cancelled' }],
    [
      'known',
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'Ship', priority: 'urgent', status: 'blocked' }]
      }
    ],
    ['unrecognized', { sessionUpdate: 'vendor_usage', tokens: 1 }],
    [
      'unrecognized',
      { sessionUpdate: 'agent_message_chunk', content: { type: 'reasoning_summary', text: 'x' } }
    ]
  ] as const)(
    'delivers %s updates without losing their original fields (%j)',
    async (kind, update) => {
      const { agent, runtime, diagnostic } = fixture()
      const events: AcpSessionEvent[] = []
      runtime.subscribe((event) => events.push(event))
      await runtime.start({ cwd: '/runtime/project', mcpServers: [] })
      const notification = { sessionId: 'session-1', update, vendor: 'retained' }
      agent.notify('session/update', notification)
      agent.notify('session/update', notification)
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual(
        kind === 'known'
          ? { kind, notification }
          : { kind, sessionId: 'session-1', raw: notification }
      )
      expect(diagnostic).toHaveBeenCalledTimes(kind === 'known' ? 0 : 1)
    }
  )

  it('rejects only envelopes missing the session id or update discriminator', async () => {
    const { agent, runtime } = fixture()
    const received = vi.fn()
    runtime.subscribe(received)
    await runtime.start({ cwd: '/runtime/project', mcpServers: [] })
    agent.notify('session/update', { update: { sessionUpdate: 'vendor' } })
    agent.notify('session/update', { sessionId: 'session-1', update: {} })
    expect(received).not.toHaveBeenCalled()
  })

  it('preserves extra session fields and exposes legacy model state as typed data', async () => {
    const { agent, runtime } = fixture()
    const models = {
      currentModelId: 'model-1',
      availableModels: [{ modelId: 'model-1', name: 'Model one' }]
    }
    agent.on('session/new', (frame) =>
      agent.reply(frame, { sessionId: 'session-1', models, vendor: true })
    )
    const started = await runtime.start({ cwd: '/runtime/project', mcpServers: [] })
    expect(started.response.models?.availableModels[0].modelId).toBe('model-1')
    expect(started.response.vendor).toBe(true)
  })
  it('delivers updates even if diagnostic and earlier event callbacks throw', async () => {
    const agent = new AcpScriptedAgent()
    const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, {
      onDiagnostic: () => {
        throw new Error('Diagnostic failed')
      }
    })
    opened.push(agent, runtime)
    runtime.subscribe(() => {
      throw new Error('Listener failed')
    })
    const received = vi.fn()
    runtime.subscribe(received)
    const notification = { sessionId: 'session-1', update: { sessionUpdate: 'vendor' } }
    agent.notify('session/update', notification)
    expect(received).toHaveBeenCalledWith({
      kind: 'unrecognized',
      sessionId: 'session-1',
      raw: notification
    })
  })
})
