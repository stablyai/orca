import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'

const mocks = vi.hoisted(() => ({
  client: null as null | {
    sessionUpdate: (notification: unknown) => Promise<void>
    extNotification: (method: string, params: Record<string, unknown>) => void
  },
  cancel: vi.fn(),
  request: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: mocks.spawn }))
vi.mock('./acp-session-start', () => ({
  startAcpSession: vi.fn(async () => ({
    capabilities: {},
    sessionId: 'session-1',
    modes: null,
    configOptions: []
  }))
}))
vi.mock('@agentclientprotocol/sdk', () => ({
  RequestError: class extends Error {
    constructor(
      readonly code: number,
      message: string
    ) {
      super(message)
    }
  },
  ClientSideConnection: class {
    closed = new Promise(() => undefined)
    request = mocks.request
    cancel = mocks.cancel
    constructor(client: () => NonNullable<typeof mocks.client>) {
      mocks.client = client()
    }
  },
  ndJsonStream: vi.fn(() => ({}))
}))

import { AcpConversationDriver } from './acp-driver'

const sink = {
  emit: vi.fn(),
  setProviderSessionId: vi.fn(),
  setConfiguration: vi.fn(),
  setContext: vi.fn(),
  setSubagents: vi.fn(),
  setTranscriptPath: vi.fn()
} satisfies HarnessConversationDriverSink

beforeEach(() => {
  vi.clearAllMocks()
  mocks.client = null
  mocks.request.mockResolvedValue({ status: 'queued' })
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.kill = vi.fn()
    return child
  })
})

describe('AcpConversationDriver Grok steer', () => {
  it('uses xAI response boundaries without guessing an end-turn message phase', async () => {
    const driver = new AcpConversationDriver({
      agent: 'grok',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: 'grok',
      args: ['agent', 'stdio'],
      env: {},
      sink
    })
    await driver.ready()
    mocks.client!.extNotification('_x.ai/session/update', {
      sessionId: 'session-1',
      update: { sessionUpdate: 'response_started', message_id: 'response-1' }
    })
    await mocks.client!.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-1',
        content: { type: 'text', text: 'Visible response' }
      }
    })
    mocks.client!.extNotification('_x.ai/session/update', {
      sessionId: 'session-1',
      update: { sessionUpdate: 'response_completed', stop_reason: 'end_turn' }
    })

    const completed = sink.emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'message.completed')
    expect(completed).toMatchObject({
      message: { blocks: [{ type: 'text', text: 'Visible response' }] }
    })
    expect(completed?.type === 'message.completed' ? completed.message : null).not.toHaveProperty(
      'assistantPhase'
    )
  })

  it('keeps non-terminal and terminal xAI responses separate and ordered', async () => {
    const driver = new AcpConversationDriver({
      agent: 'grok',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: 'grok',
      args: ['agent', 'stdio'],
      env: {},
      sink
    })
    await driver.ready()
    for (const [id, text, stopReason] of [
      ['response-1', 'Before tool', 'tool_use'],
      ['response-2', 'Final answer', 'end_turn']
    ] as const) {
      mocks.client!.extNotification('_x.ai/session/update', {
        sessionId: 'session-1',
        update: { sessionUpdate: 'response_started', message_id: id }
      })
      await mocks.client!.sessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text }
        }
      })
      mocks.client!.extNotification('_x.ai/session/update', {
        sessionId: 'session-1',
        update: { sessionUpdate: 'response_completed', stop_reason: stopReason }
      })
    }

    const completed = sink.emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'message.completed')
      .map((event) => event.message)
    expect(completed).toMatchObject([
      {
        id: 'acp:assistant:message:response-1',
        assistantPhase: 'commentary',
        blocks: [{ type: 'text', text: 'Before tool' }]
      },
      {
        id: 'acp:assistant:message:response-2',
        blocks: [{ type: 'text', text: 'Final answer' }]
      }
    ])
    expect(completed[1]).not.toHaveProperty('assistantPhase')
  })

  it('uses x.ai/interject and accepts the matching active prompt', async () => {
    const driver = new AcpConversationDriver({
      agent: 'grok',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: 'grok',
      args: ['agent', 'stdio'],
      env: {},
      sink
    })
    await driver.ready()
    const accept = vi.fn(async () => undefined)
    const steering = driver.steer('change course', undefined, crypto.randomUUID(), accept)
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce())
    await mocks.client!.sessionUpdate({
      sessionId: 'session-1',
      _meta: { promptId: 'prompt-1' },
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' }
      }
    })
    await steering

    expect(mocks.request).toHaveBeenCalledWith(
      'x.ai/interject',
      expect.objectContaining({ sessionId: 'session-1', text: 'change course' })
    )
    expect(accept).toHaveBeenCalledWith({ placement: 'current' })
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('tracks independent fallback turns for consecutive queued interjections', async () => {
    const driver = new AcpConversationDriver({
      agent: 'grok',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: 'grok',
      args: ['agent', 'stdio'],
      env: {},
      sink
    })
    await driver.ready()
    const completions: Promise<void>[] = []
    const accept = vi.fn(async (result: { placement: string; completion?: Promise<void> }) => {
      if (result.completion) {
        completions.push(result.completion)
      }
    })

    for (const promptId of ['interject-fallback-1', 'interject-fallback-2']) {
      const steering = driver.steer(promptId, undefined, crypto.randomUUID(), accept)
      await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(completions.length + 1))
      await mocks.client!.sessionUpdate({
        _meta: { promptId },
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }
      })
      await steering
    }
    expect(completions).toHaveLength(2)

    await mocks.client!.sessionUpdate({
      _meta: { promptId: 'interject-fallback-1' },
      update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
    })
    await expect(completions[0]).resolves.toBeUndefined()
    let secondSettled = false
    void completions[1].then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    await mocks.client!.sessionUpdate({
      _meta: { promptId: 'interject-fallback-2' },
      update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }
    })
    await expect(completions[1]).resolves.toBeUndefined()
  })

  it('disables Grok steer for the session after method-not-found', async () => {
    const { RequestError } = await import('@agentclientprotocol/sdk')
    mocks.request.mockRejectedValueOnce(new RequestError(-32601, 'method not found'))
    const driver = new AcpConversationDriver({
      agent: 'grok',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: 'grok',
      args: ['agent', 'stdio'],
      env: {},
      sink
    })
    await driver.ready()

    await expect(
      driver.steer('unsupported', undefined, crypto.randomUUID(), async () => undefined)
    ).rejects.toThrow('conversation_steer_unsupported')
    expect(sink.setConfiguration).toHaveBeenLastCalledWith(
      expect.objectContaining({ canSteer: false })
    )
    await expect(
      driver.steer('still unsupported', undefined, crypto.randomUUID(), async () => undefined)
    ).rejects.toThrow('conversation_steer_unsupported')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})
