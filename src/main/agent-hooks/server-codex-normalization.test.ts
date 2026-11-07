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

describe('Codex hook normalization', () => {
  it('tracks nested subagents with their role, model, and lifecycle state', () => {
    const root = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Coordinate the review',
        model: 'gpt-5.4'
      }),
      'production'
    )
    expect(root?.payload.model).toBe('gpt-5.4')

    const started = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'SubagentStart',
        session_id: 'child-session',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini'
      }),
      'production'
    )
    expect(started?.providerSession).toBeUndefined()
    expect(started?.payload).toMatchObject({
      state: 'working',
      prompt: 'Coordinate the review',
      model: 'gpt-5.4',
      subagents: [
        {
          id: 'child-session',
          agentType: 'reviewer',
          model: 'gpt-5.4-mini',
          state: 'working'
        }
      ]
    })

    const waiting = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PermissionRequest',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git fetch' }
      }),
      'production'
    )
    expect(waiting?.payload.state).toBe('waiting')
    expect(waiting?.payload.subagents?.[0].state).toBe('waiting')

    const workingAgain = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'git fetch' }
      }),
      'production'
    )
    expect(workingAgain?.payload.state).toBe('working')
    expect(workingAgain?.payload.subagents?.[0].state).toBe('working')

    const rootStop = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'Stop', model: 'gpt-5.4' }),
      'production'
    )
    expect(rootStop?.payload.state).toBe('done')
    expect(rootStop?.payload.subagents).toBeUndefined()

    const resumedChild = _internals.normalizeHookPayload(
      'codex',
      buildBody({
        hook_event_name: 'PreToolUse',
        agent_id: 'child-session',
        agent_type: 'reviewer',
        model: 'gpt-5.4-mini',
        tool_name: 'exec_command',
        tool_input: { cmd: 'pnpm test' }
      }),
      'production'
    )
    expect(resumedChild?.payload.state).toBe('working')
    expect(resumedChild?.payload.subagents?.[0]).toMatchObject({
      id: 'child-session',
      state: 'working'
    })

    const stopped = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStop', agent_id: 'child-session' }),
      'production'
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.subagents).toBeUndefined()
  })
})

describe.each(['opencode', 'opencode2'] as const)('%s hook normalization', (source) => {
  it.each([
    ['UnknownError', 'failure', undefined],
    ['MessageAbortedError', 'cancellation', true]
  ])('retains the reported root outcome for %s', (errorName, outcome, interrupted) => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'SessionIdle',
        root_state: 'done',
        root_turn_error_name: errorName
      }),
      'production'
    )
    expect(result?.payload.mainAgent).toMatchObject({ state: 'done', outcome })
    expect(result?.payload.interrupted).toBe(interrupted)
  })

  it('does not infer an outcome for an older plugin', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({ hook_event_name: 'SessionIdle' }),
      'production'
    )
    expect(result?.payload.mainAgent).toBeUndefined()
  })

  it('keeps a root failure beside still-working child work', () => {
    const result = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'SessionBusy',
        root_state: 'done',
        root_turn_error_name: 'api'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.mainAgent).toMatchObject({ state: 'done', outcome: 'failure' })
  })

  it('caps oversized MessagePart text from stale (pre-throttle) plugin builds', () => {
    // Older plugins resend full replies on each update; cap per-event work.
    const assistant = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'assistant',
        text: 'a'.repeat(500_000)
      }),
      'production'
    )
    expect(assistant?.payload.lastAssistantMessage?.length).toBe(8_000)

    const user = _internals.normalizeHookPayload(
      source,
      buildBody({
        hook_event_name: 'MessagePart',
        role: 'user',
        text: 'u'.repeat(500_000),
        messageID: 'msg-cap'
      }),
      'production'
    )
    expect(user?.payload.prompt?.length).toBe(200)
  })
})
