import { describe, expect, it } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

// Why: OMP's only boot-time event is session_start, so its absence left a
// resumed-but-idle OMP pane unregistered until the user's first turn.
describe('OMP status extension session_start', () => {
  it('registers OMP session_start so a resumed idle pane reports its resume id', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    expect(harness.handlers.session_start).toBeTypeOf('function')

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: {
          getSessionId: () => 'omp-session-1',
          getSessionFile: () => '/tmp/omp-session-1.jsonl'
        }
      }
    )

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/omp')
    // Why: OMP resumes by id alone, so the transcript path must stay undisclosed.
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start',
      session_id: 'omp-session-1'
    })
  })

  it('skips the OMP status post when session_start is a reload', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const sessionManager = {
      getSessionId: () => 'omp-reloaded',
      getSessionFile: () => '/tmp/omp-reloaded.jsonl'
    }

    await harness.callHook('session_start', { reason: 'reload' }, { sessionManager })
    expect(harness.fetchMock).not.toHaveBeenCalled()

    await harness.callHook('agent_start', undefined, { sessionManager })
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'agent_start',
      session_id: 'omp-reloaded'
    })
  })

  it('omits an ephemeral OMP session id from the session_start post', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      { sessionManager: { getSessionId: () => 'omp-ephemeral' } }
    )

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start'
    })
  })
})
