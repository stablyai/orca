import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  // Only the wall clock is faked, so the hook server's real sockets keep working.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// A finished turn's verdict and clock belong to that turn: an event restating the same finished
// turn keeps them, and only a new turn or a new session replaces them.
describe('main agent turn verdicts and clocks', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  async function post(path: string, payload: Record<string, unknown>): Promise<void> {
    const response = await postHookEvent(server, buildBody(payload), path)
    expect(response.status).toBe(204)
  }

  it('starts a new Claude session with its own main agent clock', async () => {
    await post('/hook/claude', { hook_event_name: 'UserPromptSubmit', prompt: 'first' })
    await post('/hook/claude', { hook_event_name: 'Stop' })
    expect(server.getStatusSnapshot()[0]?.mainAgent).toEqual({
      state: 'done',
      stateStartedAt: 1_000_000
    })

    vi.setSystemTime(1_060_000)
    await post('/hook/claude', { hook_event_name: 'SessionStart', source: 'clear' })

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', stateStartedAt: 1_060_000 }
    })
  })

  it.each(['idle_prompt notification', 'session end'] as const)(
    'keeps a cancelled Grok turn verdict when a %s restates done',
    async (restatement) => {
      const turn = { sessionId: 'session-1', promptId: 'prompt-1' }
      await post('/hook/grok', { hookEventName: 'user_prompt_submit', ...turn, prompt: 'go' })
      await post('/hook/grok', { hookEventName: 'stop_cancelled', ...turn })
      const cancelled = server.getStatusSnapshot()[0]?.mainAgent
      expect(cancelled).toMatchObject({ state: 'done', outcome: 'cancellation' })

      // Past the late-event suppression window, so the restatement itself is published.
      vi.setSystemTime(1_030_000)
      await post(
        '/hook/grok',
        restatement === 'session end'
          ? { hookEventName: 'session_end', ...turn }
          : { hookEventName: 'notification', ...turn, notificationType: 'idle_prompt' }
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', mainAgent: cancelled })
    }
  )

  it("keeps Codex's own cancellation across a late root Stop for the same turn", async () => {
    await post('/hook/codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'long task',
      turn_id: 'turn-1'
    })
    vi.setSystemTime(1_001_000)
    await post('/hook/codex', { hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    const cancelled = server.getStatusSnapshot()[0]?.mainAgent
    expect(cancelled).toMatchObject({ state: 'done', outcome: 'cancellation' })

    vi.setSystemTime(1_002_000)
    await post('/hook/codex', { hook_event_name: 'Stop', turn_id: 'turn-1' })
    // Readers that predate `mainAgent` must still read the restated turn as stopped, not finished.
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: cancelled
    })
    vi.setSystemTime(1_060_000)
    await post('/hook/codex', { hook_event_name: 'SubagentStart', agent_id: 'child-1' })

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', mainAgent: cancelled })
  })

  it('reads a Codex hook for another turn as working again right after a cancel', async () => {
    await post('/hook/codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'long task',
      turn_id: 'turn-1'
    })
    await post('/hook/codex', { hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    expect(server.getStatusSnapshot()[0]?.mainAgent).toMatchObject({ outcome: 'cancellation' })

    // Codex starts this turn itself: no prompt, and within any late-event window.
    vi.setSystemTime(1_001_000)
    await post('/hook/codex', {
      hook_event_name: 'PreToolUse',
      turn_id: 'turn-2',
      tool_name: 'Bash'
    })

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'working', stateStartedAt: 1_001_000 }
    })
  })

  it("keeps a relayed Codex cancellation the relay's own listener decided", () => {
    // The relay runs the same listener on the raw hooks and forwards what it publishes.
    const relayState = createHookListenerState()
    const relayed = (hook: Record<string, unknown>): void => {
      const event = normalizeHookPayload(
        relayState,
        'codex',
        { paneKey: PANE, payload: { prompt: 'long task', ...hook } },
        'production'
      )
      if (!event) {
        throw new Error('the relay published nothing')
      }
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: event.hookEventName,
          ...(event.toolAgentId ? { toolAgentId: event.toolAgentId } : {}),
          payload: event.payload
        },
        'conn-1'
      )
    }
    relayed({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1' })
    relayed({ hook_event_name: 'SubagentStart', agent_id: 'child-1' })
    vi.setSystemTime(1_001_000)
    relayed({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    const cancelled = server.getStatusSnapshot()[0]?.mainAgent
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    vi.setSystemTime(1_002_000)
    // A root hook the cancel overtook restates the cancelled turn; it must not revive it.
    relayed({ hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    relayed({ hook_event_name: 'PreToolUse', agent_id: 'child-1', tool_name: 'Bash' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', mainAgent: cancelled })

    relayed({ hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: cancelled
    })
  })
})
