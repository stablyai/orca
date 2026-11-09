import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from '../../../agent-hook-server'
import { buildBody } from '../../server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../../telemetry/cohort-classifier', () => ({
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
})
