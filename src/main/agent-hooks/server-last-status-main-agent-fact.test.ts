import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, recentTs, PANE } from './server.test-fixtures'

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
})

afterEach(() => {
  vi.restoreAllMocks()
})

// The main agent fact rides inside the persisted payload. Without these pins the field would look
// shipped while dying at every restart: hydration rebuilds only the fields it is taught.
describe('The main agent fact across a restart', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-main-agent-fact-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  function writeEntry(entry: Record<string, unknown>): void {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: { [PANE]: { paneKey: PANE, tabId: 'tab-1', ...entry } }
      })
    )
  }

  it('round-trips a settled main agent held open by a child through disk and back', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'finish after child' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    await postHookEvent(firstServer, buildBody({ hook_event_name: 'Stop', is_interrupt: true }))
    const live = firstServer.getStatusSnapshot()[0]
    expect(live).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: expect.any(Number) }
    })
    firstServer.flushStatusPersistSync()
    firstServer.stop()
    const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8'))
    expect(file.entries[PANE].payload.mainAgent).toEqual(live?.mainAgent)
    expect(file.entries[PANE]).not.toHaveProperty('claudeLeadBoundaryChildOnly')

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true,
        mainAgent: live?.mainAgent
      })
      // The seeded main agent record is what lets the child's drain settle the pane, verdict intact.
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'arestored-child' })
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: {
          state: 'done',
          outcome: 'cancellation',
          stateStartedAt: live?.mainAgent?.stateStartedAt
        }
      })
    } finally {
      server.stop()
    }
  })

  // Current Claude sends no hook on a cancel, so the inferred Ctrl+C is the path users take.
  it('round-trips an inferred cancel held open by a child through disk and back', async () => {
    const firstServer = new AgentHookServer()
    await firstServer.start({ env: 'production', userDataPath })
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'finish after child' })
    )
    await postHookEvent(
      firstServer,
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'arestored-child' })
    )
    const baseline = firstServer.getStatusSnapshot()[0]
    expect(
      firstServer.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: baseline.prompt,
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })
    ).toBe(true)
    const live = firstServer.getStatusSnapshot()[0]
    expect(live).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    firstServer.flushStatusPersistSync()
    firstServer.stop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'arestored-child' })
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    } finally {
      server.stop()
    }
  })

  it('maps the legacy child-only flag onto an absent main agent, dated by the turn end', async () => {
    const receivedAt = recentTs()
    writeEntry({
      receivedAt,
      stateStartedAt: receivedAt - 5_000,
      claudeLeadBoundaryChildOnly: true,
      payload: {
        state: 'working',
        prompt: 'legacy row',
        agentType: 'claude',
        turnCompletedAt: receivedAt - 1_000,
        subagents: [{ id: 'arestored-child', state: 'working', startedAt: receivedAt - 4_000 }]
      }
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', stateStartedAt: receivedAt - 1_000 }
      })
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'arestored-child' })
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done' }
      })
    } finally {
      server.stop()
    }
  })

  it.each([
    ['a child permission wait', 'waiting', ['PreToolUse', 'SubagentStop']],
    ['a drained row', 'done', ['SubagentStart', 'SubagentStop']]
  ] as const)(
    'settles a legacy flagged row holding %s once its child finishes',
    async (_heldRow, state, childEvents) => {
      const receivedAt = recentTs()
      writeEntry({
        receivedAt,
        stateStartedAt: receivedAt - 5_000,
        claudeLeadBoundaryChildOnly: true,
        payload: {
          state,
          prompt: 'legacy row',
          agentType: 'claude',
          ...(state === 'waiting'
            ? {
                toolName: 'Bash',
                subagents: [{ id: 'achild', state: 'working', startedAt: receivedAt - 4_000 }]
              }
            : {})
        }
      })
      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      try {
        for (const hookEventName of childEvents) {
          await postHookEvent(
            server,
            buildBody({
              hook_event_name: hookEventName,
              agent_id: 'achild',
              ...(hookEventName === 'PreToolUse'
                ? { tool_name: 'Bash', tool_use_id: 'toolu-approved' }
                : {})
            })
          )
        }
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done' }
        })
      } finally {
        server.stop()
      }
    }
  )

  it('does not restore a settled main agent from a row that does not say whether a shell ran', async () => {
    const receivedAt = recentTs()
    writeEntry({
      receivedAt,
      stateStartedAt: receivedAt - 5_000,
      payload: {
        state: 'working',
        prompt: 'unknown shell',
        agentType: 'claude',
        mainAgent: { state: 'done', stateStartedAt: receivedAt - 2_000 },
        subagents: [{ id: 'achild', state: 'working', startedAt: receivedAt - 4_000 }]
      }
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await postHookEvent(
        server,
        buildBody({ hook_event_name: 'SubagentStop', agent_id: 'achild' })
      )

      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        restoredUnconfirmed: true
      })
    } finally {
      server.stop()
    }
  })

  it('prefers a persisted main agent over the legacy flag when a row carries both', async () => {
    const receivedAt = recentTs()
    const mainAgent = { state: 'done', outcome: 'cancellation', stateStartedAt: receivedAt - 2_000 }
    writeEntry({
      receivedAt,
      stateStartedAt: receivedAt - 5_000,
      claudeLeadBoundaryChildOnly: true,
      payload: {
        state: 'working',
        prompt: 'both',
        agentType: 'claude',
        turnCompletedAt: receivedAt - 1_000,
        mainAgent,
        subagents: [{ id: 'arestored-child', state: 'working', startedAt: receivedAt - 4_000 }]
      }
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()[0]?.mainAgent).toEqual(mainAgent)
    } finally {
      server.stop()
    }
  })

  it('drops a malformed persisted main agent and keeps the row', async () => {
    const receivedAt = recentTs()
    writeEntry({
      receivedAt,
      stateStartedAt: receivedAt - 5_000,
      payload: { state: 'done', prompt: 'survived', agentType: 'claude', mainAgent: 'done' }
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const row = server.getStatusSnapshot()[0]
      expect(row).toMatchObject({ state: 'done', prompt: 'survived' })
      expect(row?.mainAgent).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('never invents a main agent for a non-Claude row from the legacy flag', async () => {
    const receivedAt = recentTs()
    writeEntry({
      receivedAt,
      stateStartedAt: receivedAt - 5_000,
      claudeLeadBoundaryChildOnly: true,
      payload: { state: 'working', prompt: 'codex row', agentType: 'codex' }
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()[0]?.mainAgent).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('hydrates a failed turn as a confirmed row that keeps its verdict', async () => {
    const receivedAt = recentTs()
    const mainAgent = { state: 'done', outcome: 'failure', stateStartedAt: receivedAt - 1_000 }
    writeEntry({
      receivedAt,
      stateStartedAt: receivedAt - 1_000,
      payload: { state: 'done', prompt: 'failed turn', agentType: 'claude', mainAgent }
    })
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const row = server.getStatusSnapshot()[0]
      expect(row).toMatchObject({ state: 'done', mainAgent })
      expect(row?.restoredUnconfirmed).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
