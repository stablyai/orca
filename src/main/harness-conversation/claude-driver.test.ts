import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessConversationDriverSink } from './driver'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

import { ClaudeConversationDriver } from './claude-driver'

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
  queryMock.mockReturnValue({
    initializationResult: () => new Promise(() => undefined),
    async *[Symbol.asyncIterator]() {}
  })
})

describe('ClaudeConversationDriver', () => {
  it('uses Orca’s resolved Claude binary and existing yolo mode', () => {
    new ClaudeConversationDriver({
      agent: 'claude',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: '/opt/bin/claude',
      commandArgs: [],
      permissionMode: 'yolo',
      env: {},
      sink
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: '/opt/bin/claude',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          canUseTool: undefined
        })
      })
    )
    expect(queryMock.mock.calls[0]?.[0].options).not.toHaveProperty('includeHookEvents')
  })

  it('runs OpenClaude through the same Agent SDK transport and selected binary', () => {
    new ClaudeConversationDriver({
      agent: 'openclaude',
      cwd: '/repo',
      providerSessionId: null,
      forkFromProviderSessionId: null,
      command: '/opt/bin/openclaude',
      commandArgs: [],
      permissionMode: 'manual',
      env: {},
      sink
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: '/opt/bin/openclaude',
          extraArgs: { 'replay-user-messages': null }
        })
      })
    )
  })

  it.each(['claude', 'openclaude'] as const)(
    'uses replayed priority-next messages to steer %s without interrupting',
    async (agent) => {
      const incoming: unknown[] = []
      const waiters: ((value: IteratorResult<unknown>) => void)[] = []
      let prompt!: AsyncIterable<unknown>
      const push = (value: unknown): void => {
        const waiter = waiters.shift()
        if (waiter) {
          waiter({ value, done: false })
        } else {
          incoming.push(value)
        }
      }
      const interrupt = vi.fn()
      queryMock.mockImplementation(({ prompt: value }) => {
        prompt = value
        return {
          initializationResult: async () => ({ commands: [], models: [] }),
          setModel: vi.fn(),
          applyFlagSettings: vi.fn(),
          interrupt,
          close: vi.fn(),
          [Symbol.asyncIterator]: () => ({
            next: () =>
              incoming.length
                ? Promise.resolve({ value: incoming.shift(), done: false })
                : new Promise((resolve) => waiters.push(resolve))
          })
        }
      })
      const driver = new ClaudeConversationDriver({
        agent,
        cwd: '/repo',
        providerSessionId: null,
        forkFromProviderSessionId: null,
        command: agent,
        commandArgs: [],
        permissionMode: 'manual',
        env: {},
        sink
      })
      await driver.ready()
      const prompts = prompt[Symbol.asyncIterator]()
      const sending = driver.send('start')
      await prompts.next()
      const accept = vi.fn(async () => undefined)
      const steering = driver.steer('change course', undefined, crypto.randomUUID(), accept)
      const steered = (await prompts.next()).value as { uuid: string; priority?: string }

      expect(steered.priority).toBe('next')
      push({
        type: 'user',
        uuid: steered.uuid,
        session_id: '',
        parent_tool_use_id: null,
        isReplay: true,
        message: { role: 'user', content: 'change course' }
      })
      await steering
      expect(accept).toHaveBeenCalledWith({ placement: 'current' })
      expect(interrupt).not.toHaveBeenCalled()

      push({
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: '',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Observed steer' }]
        }
      })
      push({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        uuid: 'result-1',
        session_id: '',
        usage: { iterations: [] },
        modelUsage: {}
      })
      await sending
      const assistantEvents = sink.emit.mock.calls
        .map(([event]) => event)
        .filter(
          (event) => event.type === 'message.completed' && event.message.id === 'claude:assistant-1'
        )
      expect(assistantEvents).toHaveLength(2)
      expect(
        assistantEvents[0]?.type === 'message.completed' ? assistantEvents[0].message : null
      ).not.toHaveProperty('assistantPhase')
      expect(assistantEvents[1]).toMatchObject({ message: { assistantPhase: 'final' } })
      await driver.close()
    }
  )
})
