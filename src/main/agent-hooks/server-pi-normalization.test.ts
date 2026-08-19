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

describe('Pi hook normalization', () => {
  it('before_agent_start maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'rename this fn' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('pi')
    expect(result?.payload.prompt).toBe('rename this fn')
  })

  it('OMP uses Pi-compatible events but keeps OMP agent attribution', () => {
    const started = _internals.normalizeHookPayload(
      'omp',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'status for omp' }),
      'production'
    )
    expect(started?.payload).toMatchObject({
      state: 'working',
      prompt: 'status for omp',
      agentType: 'omp'
    })

    const done = _internals.normalizeHookPayload(
      'omp',
      buildBody({ hook_event_name: 'agent_end' }),
      'production'
    )
    expect(done?.payload).toMatchObject({
      state: 'done',
      prompt: 'status for omp',
      agentType: 'omp'
    })
  })

  it('agent_start without a prompt keeps the cached prompt from the current turn', () => {
    _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'first prompt' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'agent_start' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('first prompt')
  })

  it('before_agent_start clears the previous turn’s tool cache', () => {
    _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'tool_call',
        tool_name: 'bash',
        tool_input: { command: 'ls' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'next' }),
      'production'
    )
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('tool_call surfaces tool_name + tool_input preview', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'tool_call',
        tool_name: 'bash',
        tool_input: { command: 'pnpm test' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('bash')
    expect(result?.payload.toolInput).toBe('pnpm test')
  })

  it('tool_execution_start also populates the tool preview', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'tool_execution_start',
        tool_name: 'read',
        tool_input: { path: 'src/main/index.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('read')
    expect(result?.payload.toolInput).toBe('src/main/index.ts')
  })

  it('message_end (assistant) stays in working but captures lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'message_end',
        role: 'assistant',
        text: 'Done — I refactored the helper.'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('Done — I refactored the helper.')
  })

  it('message_end (user) is ignored', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'message_end', role: 'user', text: 'hi' }),
      'production'
    )
    // Why: pi captures the user prompt via before_agent_start, so a user-role message_end must not flip lastAssistantMessage.
    expect(result?.payload.lastAssistantMessage).toBeUndefined()
  })

  it('agent_end maps to done', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'agent_end' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.agentType).toBe('pi')
  })

  it('session_shutdown leaves a running Pi status intact', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'session_shutdown' }),
      'production'
    )
    // Why: Pi emits shutdown on reload/replace while the PTY stays alive; only agent_end proves turn completion.
    expect(result).toBeNull()
  })

  it('done preserves the cached lastAssistantMessage from a prior message_end', () => {
    _internals.normalizeHookPayload(
      'pi',
      buildBody({
        hook_event_name: 'message_end',
        role: 'assistant',
        text: 'final reply'
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'agent_end' }),
      'production'
    )
    expect(result?.payload.lastAssistantMessage).toBe('final reply')
  })

  it('unknown event names are dropped', () => {
    const result = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'never_heard_of_it' }),
      'production'
    )
    expect(result).toBeNull()
  })
})
