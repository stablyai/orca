import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

beforeEach(() => _internals.resetCachesForTests())
afterEach(() => vi.restoreAllMocks())

it.each([true, false])('publishes a DSH Stop event with is_interrupt=%s', (interrupted) => {
  const server = new AgentHookServer()
  const listener = vi.fn()
  server.setListener(listener)
  const post = (payload: Record<string, unknown>) => {
    const event = _internals.normalizeHookPayload(
      'dsh-console',
      buildBody({ session_id: 'dsh-console-session', prompt: 'run a task', ...payload }),
      'production'
    )
    expect(event).not.toBeNull()
    server.ingestRemote(event!, 'dsh-host')
  }
  try {
    post({ hook_event_name: 'UserPromptSubmit', state: 'working' })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE, state: 'working', agentType: 'dsh-console' })
    ])

    post({ hook_event_name: 'Stop', state: 'done', is_interrupt: interrupted })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        state: 'done',
        agentType: 'dsh-console',
        interrupted: interrupted || undefined,
        providerSession: { key: 'session_id', id: 'dsh-console-session' }
      })
    ])
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        payload: expect.objectContaining({ state: 'done', interrupted: interrupted || undefined })
      })
    )

    post({ hook_event_name: 'UserPromptSubmit', state: 'working', prompt: 'next task' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', prompt: 'next task' })
    expect(server.getStatusSnapshot()[0].interrupted).not.toBe(true)
  } finally {
    server.stop()
  }
})
