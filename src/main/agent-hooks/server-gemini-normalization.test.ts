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

describe('Gemini hook normalization', () => {
  it('BeforeTool surfaces toolName + toolInput', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        tool_input: { path: '/src/index.ts' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('read_file')
    expect(result?.payload.toolInput).toBe('/src/index.ts')
  })

  it('falls back to args when tool_input is absent', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'BeforeTool',
        tool_name: 'run_shell_command',
        args: { command: 'git status' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('run_shell_command')
    expect(result?.payload.toolInput).toBe('git status')
  })

  it('BeforeAgent clears the cached tool state from a prior turn', () => {
    _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        tool_input: { path: '/stale.ts' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({ hook_event_name: 'BeforeAgent' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBeUndefined()
    expect(result?.payload.toolInput).toBeUndefined()
  })

  it('AfterAgent reports done without introducing tool fields on its own', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({ hook_event_name: 'AfterAgent' }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.toolName).toBeUndefined()
  })

  it('AfterAgent carries prompt_response into lastAssistantMessage', () => {
    const result = _internals.normalizeHookPayload(
      'gemini',
      buildBody({
        hook_event_name: 'AfterAgent',
        prompt: 'what did you do',
        prompt_response: 'I ran the tests and they passed.',
        stop_hook_active: false
      }),
      'production'
    )
    expect(result?.payload.state).toBe('done')
    expect(result?.payload.lastAssistantMessage).toBe('I ran the tests and they passed.')
  })
})
