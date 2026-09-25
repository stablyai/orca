// The server's re-check of an inferred interrupt judges the main agent's turn, not the row's write
// time: a subagent hook that lands between the keypress and the request no longer voids a cancel
// the main agent never answered with a hook of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE, buildBody } from './server.test-fixtures'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

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
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function ingest(
  server: AgentHookServer,
  at: number,
  hookEventName: string,
  payload: AgentHookEventPayload['payload'],
  toolAgentId?: string
): void {
  vi.setSystemTime(at)
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      hookEventName,
      ...(toolAgentId ? { toolAgentId } : {}),
      payload
    },
    'conn-1'
  )
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshot()[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

/** A Codex turn with a working subagent, as it stands when the user presses Ctrl+C. */
function startTurnWithSubagent(server: AgentHookServer): ReturnType<typeof row> {
  ingest(server, 1_000, 'UserPromptSubmit', {
    state: 'working',
    prompt: 'long task',
    agentType: 'codex'
  })
  ingest(
    server,
    1_100,
    'SubagentStart',
    {
      state: 'working',
      prompt: 'long task',
      agentType: 'codex',
      subagents: [{ id: 'agent-1', state: 'working', startedAt: 1_100 }]
    },
    'agent-1'
  )
  const baseline = row(server)
  expect(baseline).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  return baseline
}

/** A main agent Stop that still lists the running subagent, so the roster keeps the row open. */
function mainAgentStop(server: AgentHookServer, at: number): void {
  ingest(server, at, 'Stop', {
    state: 'done',
    prompt: 'long task',
    agentType: 'codex',
    subagents: [{ id: 'agent-1', state: 'working', startedAt: 1_100 }]
  })
}

function childToolHook(server: AgentHookServer, at: number): void {
  ingest(server, at, 'PreToolUse', { state: 'working', prompt: '', agentType: 'codex' }, 'agent-1')
}

function inferCtrlC(
  server: AgentHookServer,
  baseline: ReturnType<typeof row>,
  sendMainAgentBaseline: boolean
): boolean {
  vi.setSystemTime(1_600)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'codex',
    ...(sendMainAgentBaseline && baseline.mainAgent
      ? { baselineMainAgentStateStartedAt: baseline.mainAgent.stateStartedAt }
      : {}),
    intent: 'ctrl-c'
  })
}

describe('inferInterrupt baselined on the main agent turn', () => {
  it('admits a cancel when only a subagent hook re-stamped the row after the keypress', () => {
    const server = new AgentHookServer()
    const baseline = startTurnWithSubagent(server)
    childToolHook(server, 1_300)
    expect(row(server).receivedAt).not.toBe(baseline.receivedAt)

    expect(inferCtrlC(server, baseline, true)).toBe(true)
    expect(row(server)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: 'agent-1', state: 'working' })]
    })
  })

  it('admits a cancel when a same-turn main agent tool hook re-stamped the row', () => {
    const server = new AgentHookServer()
    const baseline = startTurnWithSubagent(server)
    ingest(server, 1_300, 'PreToolUse', {
      state: 'working',
      prompt: 'long task',
      agentType: 'codex'
    })

    expect(inferCtrlC(server, baseline, true)).toBe(true)
    expect(row(server).mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('refuses when the main agent ended its turn after the keypress', () => {
    const server = new AgentHookServer()
    const baseline = startTurnWithSubagent(server)
    mainAgentStop(server, 1_300)
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

    expect(inferCtrlC(server, baseline, true)).toBe(false)
    expect(row(server).mainAgent).not.toHaveProperty('outcome')
  })

  it('refuses when a new main agent turn with the same prompt began after the keypress', () => {
    const server = new AgentHookServer()
    const baseline = startTurnWithSubagent(server)
    mainAgentStop(server, 1_200)
    ingest(server, 1_300, 'UserPromptSubmit', {
      state: 'working',
      prompt: 'long task',
      agentType: 'codex'
    })
    expect(row(server).mainAgent).toMatchObject({ state: 'working', stateStartedAt: 1_300 })

    expect(inferCtrlC(server, baseline, true)).toBe(false)
    expect(row(server).mainAgent).toMatchObject({ state: 'working' })
  })

  it('keeps the strict row write-time match for a request without the main agent baseline', () => {
    const server = new AgentHookServer()
    const baseline = startTurnWithSubagent(server)
    childToolHook(server, 1_300)

    expect(inferCtrlC(server, baseline, false)).toBe(false)
    expect(row(server).mainAgent).toMatchObject({ state: 'working' })
  })

  it('ignores a malformed main agent baseline and falls back to the row write time', () => {
    const server = new AgentHookServer()
    const baseline = startTurnWithSubagent(server)
    childToolHook(server, 1_300)
    vi.setSystemTime(1_600)

    // The IPC handler forwards an untyped request; JSON.parse yields one the same way.
    const malformed: Parameters<AgentHookServer['inferInterrupt']>[0] = JSON.parse(
      JSON.stringify({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: baseline.prompt,
        baselineAgentType: 'codex',
        baselineMainAgentStateStartedAt: String(baseline.mainAgent?.stateStartedAt),
        intent: 'ctrl-c'
      })
    )
    expect(server.inferInterrupt(malformed)).toBe(false)
  })
})

describe('inferInterrupt baselined on the OpenCode root session turn', () => {
  function ingestOpenCode(
    server: AgentHookServer,
    at: number,
    hook: Record<string, unknown>
  ): void {
    vi.setSystemTime(at)
    const normalized = _internals.normalizeHookPayload('opencode', buildBody(hook), 'production')
    if (!normalized) {
      throw new Error('the OpenCode hook did not normalize')
    }
    ingest(server, at, String(hook.hook_event_name), normalized.payload)
  }

  function startRootTurn(server: AgentHookServer): void {
    ingestOpenCode(server, 1_000, {
      hook_event_name: 'MessagePart',
      role: 'user',
      text: 'long task',
      root_state: 'done'
    })
    ingestOpenCode(server, 1_050, { hook_event_name: 'SessionBusy', root_state: 'working' })
  }

  function inferOpenCodeCtrlC(server: AgentHookServer, baseline: ReturnType<typeof row>): boolean {
    vi.setSystemTime(1_600)
    return server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: baseline.receivedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: 'opencode',
      ...(baseline.mainAgent?.state === 'working'
        ? { baselineMainAgentStateStartedAt: baseline.mainAgent.stateStartedAt }
        : {}),
      intent: 'ctrl-c'
    })
  }

  it('admits a cancel when child posts re-stamped the row during the root turn', () => {
    const server = new AgentHookServer()
    startRootTurn(server)
    const baseline = row(server)
    expect(baseline).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    // A child's question and its answer re-post the pane while the root keeps working.
    ingestOpenCode(server, 1_200, { hook_event_name: 'AskUserQuestion', root_state: 'working' })
    ingestOpenCode(server, 1_300, { hook_event_name: 'SessionBusy', root_state: 'working' })
    expect(row(server).stateStartedAt).not.toBe(baseline.stateStartedAt)

    expect(inferOpenCodeCtrlC(server, baseline)).toBe(true)
    expect(row(server).mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('refuses a keypress at a finished root that a busy child holds open', () => {
    const server = new AgentHookServer()
    startRootTurn(server)
    ingestOpenCode(server, 1_300, { hook_event_name: 'SessionBusy', root_state: 'done' })
    const baseline = row(server)
    expect(baseline).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

    expect(inferOpenCodeCtrlC(server, baseline)).toBe(false)
    expect(row(server).mainAgent).not.toHaveProperty('outcome')
  })
})
