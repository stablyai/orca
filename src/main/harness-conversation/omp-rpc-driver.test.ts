import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'

const rpc = vi.hoisted(() => ({
  frame: (_frame: Record<string, unknown>): void => undefined,
  request: vi.fn(),
  write: vi.fn()
}))

vi.mock('./omp-rpc-connection', () => ({
  OmpRpcError: class extends Error {},
  OmpRpcConnection: class {
    constructor(
      _command: string,
      _args: string[],
      _env: NodeJS.ProcessEnv,
      _cwd: string,
      frame: (value: Record<string, unknown>) => void
    ) {
      rpc.frame = frame
    }
    ready = vi.fn(async () => undefined)
    request = rpc.request
    write = rpc.write
    close = vi.fn(async () => undefined)
  }
}))

import { OmpRpcConversationDriver } from './omp-rpc-driver'

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
  rpc.request.mockImplementation(async (type: string) => {
    if (type === 'get_state') {
      return {
        data: {
          sessionId: 'session-1',
          model: { provider: 'anthropic', id: 'claude-sonnet' },
          thinkingLevel: 'high',
          contextUsage: { tokens: 1_100, contextWindow: 200_000, percent: 0.55 }
        }
      }
    }
    if (type === 'get_available_commands') {
      return { data: { commands: [] } }
    }
    if (type === 'get_available_models') {
      return { data: { models: [] } }
    }
    return { data: {} }
  })
})

describe('OmpRpcConversationDriver', () => {
  it('keeps OMP assistant message boundaries and confirms only a stop response candidate', async () => {
    const driver = new OmpRpcConversationDriver({
      cwd: '/repo',
      command: 'omp',
      args: ['--mode', 'rpc-ui'],
      env: {},
      sink
    })
    await driver.ready()
    const active = driver.send('active')
    await vi.waitFor(() =>
      expect(rpc.request).toHaveBeenCalledWith('prompt', expect.anything(), expect.any(String))
    )
    rpc.frame({ type: 'message_start', message: { role: 'assistant' } })
    rpc.frame({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Before tool' }
    })
    rpc.frame({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'text', text: 'Before tool' }, { type: 'toolCall' }]
      }
    })
    rpc.frame({ type: 'message_start', message: { role: 'assistant' } })
    rpc.frame({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Final answer' }
    })
    rpc.frame({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Final answer' }]
      }
    })
    rpc.frame({ type: 'agent_end' })
    await active

    const completed = sink.emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'message.completed' && event.message.role === 'assistant')
    expect(completed).toHaveLength(2)
    expect(completed[0]).toMatchObject({ message: { assistantPhase: 'commentary' } })
    expect(
      completed[1]?.type === 'message.completed' ? completed[1].message : null
    ).not.toHaveProperty('assistantPhase')
    expect(completed[0]?.type === 'message.completed' ? completed[0].message.id : null).not.toBe(
      completed[1]?.type === 'message.completed' ? completed[1].message.id : null
    )
  })

  it('uses native steer and exposes OMP Approve/Deny requests', async () => {
    const driver = new OmpRpcConversationDriver({
      cwd: '/repo',
      command: 'omp',
      args: ['--mode', 'rpc-ui'],
      env: {},
      sink
    })
    await driver.ready()
    expect(sink.setContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'anthropic/claude-sonnet',
        effort: 'high',
        usedTokens: 1_100,
        maxTokens: 200_000
      })
    )
    const accept = vi.fn(async () => undefined)
    const active = driver.send('active')
    await vi.waitFor(() =>
      expect(rpc.request).toHaveBeenCalledWith('prompt', expect.anything(), expect.any(String))
    )

    await driver.steer('change course', undefined, crypto.randomUUID(), accept)
    rpc.frame({
      type: 'extension_ui_request',
      id: 'permission-1',
      method: 'select',
      title: 'Run command?',
      options: ['Approve', 'Deny']
    })
    driver.answerPermission('permission-1', 'Approve')
    rpc.frame({ type: 'agent_end', isTerminal: true })
    await active

    expect(rpc.request).toHaveBeenCalledWith(
      'steer',
      { message: 'change course', images: [] },
      expect.any(String)
    )
    expect(accept).toHaveBeenCalledWith({ placement: 'current' })
    expect(rpc.request).not.toHaveBeenCalledWith('abort')
    expect(sink.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission',
        permission: expect.objectContaining({ id: 'permission-1' })
      })
    )
    expect(rpc.write).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'permission-1',
      value: 'Approve'
    })
  })

  it('assigns a steer acknowledged after agent_end to the next turn', async () => {
    let finishSteer = (): void => undefined
    rpc.request.mockImplementation(async (type: string) => {
      if (type === 'get_state') {
        return { data: { sessionId: 'session-1' } }
      }
      if (type === 'get_available_commands') {
        return { data: { commands: [] } }
      }
      if (type === 'get_available_models') {
        return { data: { models: [] } }
      }
      if (type === 'steer') {
        return new Promise((resolve) => {
          finishSteer = () => resolve({ data: {} })
        })
      }
      return { data: {} }
    })
    const driver = new OmpRpcConversationDriver({
      cwd: '/repo',
      command: 'omp',
      args: ['--mode', 'rpc-ui'],
      env: {},
      sink
    })
    await driver.ready()
    const active = driver.send('active')
    await vi.waitFor(() =>
      expect(rpc.request).toHaveBeenCalledWith('prompt', expect.anything(), expect.any(String))
    )
    let completion: Promise<void> | undefined
    const steering = driver.steer('next course', undefined, crypto.randomUUID(), async (result) => {
      expect(result.placement).toBe('next')
      if (result.placement === 'next') {
        completion = result.completion
      }
    })
    await vi.waitFor(() =>
      expect(rpc.request).toHaveBeenCalledWith('steer', expect.anything(), expect.any(String))
    )
    rpc.frame({ type: 'agent_end' })
    await active
    finishSteer()
    await steering
    expect(completion).toBeDefined()
    rpc.frame({ type: 'agent_end' })
    await expect(completion).resolves.toBeUndefined()
  })

  it('distinguishes definitive RPC rejection from ambiguous prompt transport failure', async () => {
    const { OmpRpcError } = await import('./omp-rpc-connection')
    const driver = new OmpRpcConversationDriver({
      cwd: '/repo',
      command: 'omp',
      args: ['--mode', 'rpc-ui'],
      env: {},
      sink
    })
    await driver.ready()
    const submission = { clientMessageId: crypto.randomUUID(), accepted: vi.fn() }
    rpc.request.mockRejectedValueOnce(new OmpRpcError('rejected'))
    await expect(driver.send('rejected', undefined, submission)).rejects.toThrow('rejected')
    expect(submission.accepted).not.toHaveBeenCalled()

    rpc.request.mockRejectedValueOnce(new Error('socket closed'))
    await expect(driver.send('ambiguous', undefined, submission)).rejects.toThrow(
      'conversation_send_uncertain'
    )
    expect(submission.accepted).not.toHaveBeenCalled()
  })
})
