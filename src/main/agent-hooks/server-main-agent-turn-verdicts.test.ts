import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

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

  afterEach(async () => {
    await server.stop()
  })

  async function post(path: string, payload: Record<string, unknown>): Promise<void> {
    const response = await postHookEvent(server, buildBody(payload), path)
    expect(response.status).toBe(204)
  }

  function inferCtrlC(agentType: 'codex'): void {
    const baseline = server.getStatusSnapshot()[0]
    expect(
      server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: baseline.prompt,
        baselineAgentType: agentType,
        intent: 'ctrl-c'
      })
    ).toBe(true)
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

  it('keeps an inferred Codex cancellation across a late root Stop', async () => {
    await post('/hook/codex', { hook_event_name: 'UserPromptSubmit', prompt: 'long task' })
    vi.setSystemTime(1_001_000)
    inferCtrlC('codex')
    const cancelled = server.getStatusSnapshot()[0]?.mainAgent
    expect(cancelled).toMatchObject({ state: 'done', outcome: 'cancellation' })

    vi.setSystemTime(1_002_000)
    await post('/hook/codex', { hook_event_name: 'Stop' })
    // Readers that predate `mainAgent` must still read the restated turn as stopped, not finished.
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', interrupted: true })
    // Past the late-event suppression window, a child's activity republishes the main agent.
    vi.setSystemTime(1_060_000)
    await post('/hook/codex', { hook_event_name: 'SubagentStart', agent_id: 'child-1' })

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', mainAgent: cancelled })
  })

  it('keeps an inferred Codex cancellation across a late relayed root Stop', () => {
    const relayed = (
      hookEventName: string,
      payload: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ) =>
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName,
          ...extra,
          payload: { prompt: 'long task', agentType: 'codex', ...payload }
        },
        'conn-1'
      )
    relayed('UserPromptSubmit', { state: 'working' }, { hasExplicitPrompt: true })
    vi.setSystemTime(1_001_000)
    inferCtrlC('codex')
    const cancelled = server.getStatusSnapshot()[0]?.mainAgent
    expect(cancelled).toMatchObject({ state: 'done', outcome: 'cancellation' })

    vi.setSystemTime(1_002_000)
    relayed('Stop', { state: 'done' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', interrupted: true })
    vi.setSystemTime(1_060_000)
    relayed(
      'SubagentStart',
      {
        state: 'working',
        subagents: [{ id: 'child-1', state: 'working', startedAt: 1_060_000 }]
      },
      { toolAgentId: 'child-1' }
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', mainAgent: cancelled })
  })
})
