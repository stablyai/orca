import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, agentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

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
  it('carries the model an OMP post stamps on the pane status', () => {
    const started = _internals.normalizeHookPayload(
      'omp',
      buildBody({
        hook_event_name: 'before_agent_start',
        prompt: 'status for omp',
        model: 'deepseek/deepseek-v4-pro',
        model_switch_command: 'orca-model'
      }),
      'production'
    )
    expect(started?.payload).toMatchObject({
      state: 'working',
      agentType: 'omp',
      model: 'deepseek/deepseek-v4-pro',
      modelSwitchCommand: 'orca-model'
    })

    // Pi posts carry no model, and none is invented for them.
    const pi = _internals.normalizeHookPayload(
      'pi',
      buildBody({ hook_event_name: 'before_agent_start', prompt: 'status for pi' }),
      'production'
    )
    expect(pi?.payload.model).toBeUndefined()
  })

  it('model_select re-emits the last OMP status under the new model', () => {
    const started = _internals.normalizeHookPayload(
      'omp',
      buildBody({
        hook_event_name: 'agent_end',
        prompt: 'status for omp',
        model: 'deepseek/deepseek-v4-pro'
      }),
      'production'
    )
    expect(started).not.toBeNull()
    if (!started) {
      throw new Error('expected OMP agent_end to normalize')
    }
    agentHookServer.ingestRemote(
      {
        paneKey: started.paneKey,
        tabId: started.tabId,
        worktreeId: started.worktreeId,
        payload: started.payload
      },
      'conn-1'
    )

    const switched = _internals.normalizeHookPayload(
      'omp',
      buildBody({ hook_event_name: 'model_select', model: 'minimax-cn/MiniMax-M3' }),
      'production'
    )
    // Why: a switch between turns changes the model, never the state or the prompt.
    expect(switched?.payload).toMatchObject({
      state: 'done',
      prompt: 'status for omp',
      agentType: 'omp',
      model: 'minimax-cn/MiniMax-M3'
    })
  })

  it('model_select before any status has nothing to describe', () => {
    expect(
      _internals.normalizeHookPayload(
        'omp',
        buildBody({ hook_event_name: 'model_select', model: 'minimax-cn/MiniMax-M3' }),
        'production'
      )
    ).toBeNull()
    expect(
      _internals.normalizeHookPayload(
        'omp',
        buildBody({ hook_event_name: 'model_select' }),
        'production'
      )
    ).toBeNull()
  })

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

const SCOUT = { id: 'run-scout', state: 'working', startedAt: 1_000, agentType: 'scout' }
const REVIEWER = {
  id: 'run-reviewer',
  state: 'working',
  startedAt: 2_000,
  agentType: 'reviewer',
  description: 'Review the diff'
}

describe('Pi-family child rows through the hook lane', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  async function post(source: 'pi' | 'omp', payload: Record<string, unknown>): Promise<void> {
    const response = await postHookEvent(server, buildBody(payload), `/hook/${source}`)
    expect(response.status).toBe(204)
  }

  it.each(['pi', 'omp'] as const)(
    'publishes the %s extension roster as the row subagents',
    async (source) => {
      await post(source, {
        hook_event_name: 'before_agent_start',
        prompt: 'fan out',
        subagents: [SCOUT, REVIEWER]
      })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          agentType: source,
          prompt: 'fan out',
          subagents: [SCOUT, REVIEWER]
        })
      ])
    }
  )

  it('restates the last row with the new roster when a child ends between lead events', async () => {
    await post('pi', {
      hook_event_name: 'before_agent_start',
      prompt: 'fan out',
      subagents: [SCOUT, REVIEWER]
    })
    await post('pi', { hook_event_name: 'tool_execution_start', tool_name: 'bash' })
    await post('pi', { hook_event_name: 'subagents_update', subagents: [REVIEWER] })

    const [row] = server.getStatusSnapshot()
    expect(row).toMatchObject({
      state: 'working',
      prompt: 'fan out',
      toolName: 'bash',
      subagents: [REVIEWER]
    })

    // Why: the roster is a full restatement, so an update without one clears every child row.
    await post('pi', { hook_event_name: 'subagents_update' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', prompt: 'fan out' })
    expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  })

  it('keeps an update from inventing a row or unhiding a resume placeholder', async () => {
    await post('pi', { hook_event_name: 'subagents_update', subagents: [SCOUT] })
    expect(server.getStatusSnapshot()).toEqual([])

    await post('pi', {
      hook_event_name: 'session_start',
      session_id: 'pi-session-1',
      session_file: '/home/dev/.pi/agent/sessions/pi-session-1.jsonl'
    })
    await post('pi', { hook_event_name: 'subagents_update', subagents: [SCOUT] })
    const [placeholder] = server.getStatusSnapshot()
    expect(placeholder).toMatchObject({ providerSessionOnly: true, state: 'done' })
    expect(placeholder?.subagents).toBeUndefined()

    // Why: the same guard covers Pi's model_select, which shares this path.
    await post('pi', { hook_event_name: 'model_select', model: 'anthropic/claude-opus-5' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ providerSessionOnly: true })
    expect(server.getStatusSnapshot()[0]?.model).toBeUndefined()
  })

  it('records a run its session ended as a session boundary, not a completion', async () => {
    await post('pi', { hook_event_name: 'before_agent_start', prompt: 'fan out' })
    await post('pi', { hook_event_name: 'agent_end', session_boundary: true })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', sessionBoundary: true })

    await post('pi', { hook_event_name: 'before_agent_start', prompt: 'again' })
    await post('pi', { hook_event_name: 'agent_end' })
    expect(server.getStatusSnapshot()[0]?.sessionBoundary).toBeUndefined()
  })

  it('never lets one agent restate another agent row', async () => {
    await post('pi', { hook_event_name: 'before_agent_start', prompt: 'pi turn' })
    await post('omp', { hook_event_name: 'subagents_update', subagents: [SCOUT] })

    const [row] = server.getStatusSnapshot()
    expect(row).toMatchObject({ agentType: 'pi', prompt: 'pi turn' })
    expect(row?.subagents).toBeUndefined()
  })
})

// Why: publishing a roster for Pi puts its panes on the same child-work guard Claude and Codex
// already sit behind, which changes what Ctrl+C records. Pinned here so the next change to the
// guard — or to the extension, once it reports a main-agent state of its own — has to face it.
describe('a Pi cancel beside a live child row', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  async function startTurn(subagents?: Record<string, unknown>[]): Promise<void> {
    const response = await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'before_agent_start',
        prompt: 'fan out',
        ...(subagents ? { subagents } : {})
      }),
      '/hook/pi'
    )
    expect(response.status).toBe(204)
  }

  function pressCtrlC(): boolean {
    const baseline = server.getStatusSnapshotForPane(PANE)[0]
    if (!baseline) {
      throw new Error('the pane has no row')
    }
    return server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: baseline.receivedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: 'pi',
      intent: 'ctrl-c'
    })
  }

  it('still settles a stopped row when the pane has no children', async () => {
    await startTurn()

    expect(pressCtrlC()).toBe(true)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  // Why: without a main-agent state from the extension, Orca cannot tell a cancelled turn from
  // Ctrl+C at the idle prompt of a lead that children alone hold open — where it cancels nothing.
  // It keeps the live row rather than claiming a cancellation the children contradict.
  it('leaves the working row alone while a child still runs', async () => {
    await startTurn([{ id: 'run-scout', state: 'working', startedAt: 1_000, agentType: 'scout' }])

    expect(pressCtrlC()).toBe(false)
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(row).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'run-scout' })]
    })
    expect(row?.interrupted).toBeUndefined()
    expect(row?.mainAgent).toBeUndefined()
  })
})
