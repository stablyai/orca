import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Amp hook normalization', () => {
  it('maps agent lifecycle events to working and done states', () => {
    const start = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        message: 'wire Amp hooks'
      }),
      'production'
    )

    expect(start?.payload).toMatchObject({
      state: 'working',
      prompt: 'wire Amp hooks',
      agentType: 'amp'
    })

    const done = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.end',
        message: 'wire Amp hooks',
        status: 'done'
      }),
      'production'
    )

    expect(done?.payload).toMatchObject({
      state: 'done',
      prompt: 'wire Amp hooks',
      agentType: 'amp'
    })
  })

  it('surfaces Amp tool call and result context while preserving the prompt', () => {
    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        message: 'run tests'
      }),
      'production'
    )

    const toolCall = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.call',
        tool: 'shell_command',
        input: { command: 'pnpm test --run src/main/amp/hook-service.test.ts' }
      }),
      'production'
    )

    expect(toolCall?.payload).toMatchObject({
      state: 'working',
      prompt: 'run tests',
      agentType: 'amp',
      toolName: 'shell_command',
      toolInput: 'pnpm test --run src/main/amp/hook-service.test.ts'
    })

    const result = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.result',
        tool: 'shell_command',
        input: { command: 'pnpm test --run src/main/amp/hook-service.test.ts' },
        status: 'done',
        output: 'tests passed'
      }),
      'production'
    )

    expect(result?.payload).toMatchObject({
      state: 'working',
      prompt: 'run tests',
      agentType: 'amp',
      toolName: 'shell_command',
      toolInput: 'pnpm test --run src/main/amp/hook-service.test.ts',
      lastAssistantMessage: 'tests passed'
    })
  })

  it('does not let Amp tool result messages overwrite the cached prompt', () => {
    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        message: 'run tests'
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.result',
        tool: 'shell_command',
        input: { command: 'pnpm test' },
        message: 'tests passed'
      }),
      'production'
    )

    expect(result?.payload).toMatchObject({
      state: 'working',
      prompt: 'run tests',
      agentType: 'amp',
      lastAssistantMessage: 'tests passed'
    })

    const done = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.end',
        status: 'done'
      }),
      'production'
    )

    expect(done?.payload).toMatchObject({
      state: 'done',
      prompt: 'run tests',
      agentType: 'amp'
    })
  })

  it('keeps Amp prompt and tool caches isolated by thread id within one pane', () => {
    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        threadId: 'thread-a',
        message: 'first task'
      }),
      'production'
    )

    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        threadId: 'thread-b',
        message: 'second task'
      }),
      'production'
    )

    const threadAResult = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.result',
        threadId: 'thread-a',
        tool: 'shell_command',
        input: { command: 'pnpm test:a' },
        output: 'first done'
      }),
      'production'
    )

    expect(threadAResult?.payload).toMatchObject({
      state: 'working',
      prompt: 'first task',
      agentType: 'amp',
      toolName: 'shell_command',
      toolInput: 'pnpm test:a',
      lastAssistantMessage: 'first done'
    })

    const threadBDone = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.end',
        threadId: 'thread-b',
        status: 'done'
      }),
      'production'
    )

    expect(threadBDone?.payload).toMatchObject({
      state: 'done',
      prompt: 'second task',
      agentType: 'amp'
    })
  })

  it('drops stale Amp tool events that arrive after the thread ended', () => {
    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        threadId: 'thread-a',
        message: 'run tests'
      }),
      'production'
    )

    const done = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.end',
        threadId: 'thread-a',
        status: 'done'
      }),
      'production'
    )

    expect(done?.payload).toMatchObject({
      state: 'done',
      prompt: 'run tests',
      agentType: 'amp'
    })

    const staleToolResult = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.result',
        threadId: 'thread-a',
        tool: 'shell_command',
        input: { command: 'pnpm test' },
        message: 'tests passed'
      }),
      'production'
    )

    expect(staleToolResult).toBeNull()
  })

  it('does not mark Amp tool result messages as explicit prompts', () => {
    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        threadId: 'thread-a',
        message: 'run tests'
      }),
      'production'
    )

    const result = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.result',
        threadId: 'thread-a',
        tool: 'shell_command',
        input: { command: 'pnpm test' },
        message: 'tests passed'
      }),
      'production'
    )

    expect(result?.payload).toMatchObject({
      state: 'working',
      prompt: 'run tests',
      agentType: 'amp',
      lastAssistantMessage: 'tests passed'
    })
    expect(result?.hasExplicitPrompt).toBeUndefined()
  })

  it('marks cancelled Amp turns as interrupted done states', () => {
    const cancelled = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.end',
        message: 'stop this run',
        status: 'cancelled'
      }),
      'production'
    )

    expect(cancelled?.payload).toMatchObject({
      state: 'done',
      prompt: 'stop this run',
      agentType: 'amp',
      interrupted: true
    })
  })

  it('treats session.start as cache reset without creating a visible row', () => {
    _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'agent.start',
        message: 'old prompt'
      }),
      'production'
    )

    const sessionStart = _internals.normalizeHookPayload(
      'amp',
      buildBody({ hook_event_name: 'session.start', threadId: 'thread-1' }),
      'production'
    )
    expect(sessionStart).toBeNull()

    const nextTool = _internals.normalizeHookPayload(
      'amp',
      buildBody({
        hook_event_name: 'tool.call',
        tool: 'Read',
        input: { file_path: '/tmp/file.ts' }
      }),
      'production'
    )

    expect(nextTool?.payload).toMatchObject({
      state: 'working',
      prompt: '',
      agentType: 'amp',
      toolName: 'Read',
      toolInput: '/tmp/file.ts'
    })
  })
})
