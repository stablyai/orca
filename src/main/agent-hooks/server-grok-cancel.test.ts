// Grok 1.0.41, measured: Ctrl+C mid-turn fires `stop_cancelled` listing the finite tasks the turn
// left running, and Ctrl+C at the idle prompt kills no background task.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

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

afterEach(() => vi.restoreAllMocks())

const RUNNING_TASK = { id: 'task-1', type: 'shell', status: 'running' }

async function postGrokHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody({ sessionId: 'session-1', ...payload }))
  })
  expect(response.status).toBe(204)
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'grok',
    intent: 'ctrl-c'
  })
}

async function startTaskThenSettle(server: AgentHookServer): Promise<void> {
  await postGrokHook(server, {
    hookEventName: 'user_prompt_submit',
    promptId: 'prompt-1',
    prompt: 'start a background task'
  })
  await postGrokHook(server, {
    hookEventName: 'stop',
    promptId: 'prompt-1',
    reason: 'end_turn',
    stopHookActive: false,
    backgroundTasks: [RUNNING_TASK]
  })
  expect(row(server)).toMatchObject({
    state: 'working',
    workingMode: 'monitoring',
    mainAgent: { state: 'done' }
  })
}

describe('a Grok cancel never hides a running task', () => {
  it('refuses Ctrl+C at the idle prompt of a row a task holds open', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await startTaskThenSettle(server)
      const before = row(server)
      expect(pressCtrlC(server)).toBe(false)
      expect(row(server)).toEqual(before)
    } finally {
      server.stop()
    }
  })

  it("shows the task when Grok's own cancel hook trails the inferred cancel", async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await startTaskThenSettle(server)
      await postGrokHook(server, {
        hookEventName: 'user_prompt_submit',
        promptId: 'prompt-2',
        prompt: 'now do something else'
      })
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      // Why: the inference can win the settle race; the row cannot see the task behind a working main agent.
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      await postGrokHook(server, {
        hookEventName: 'stop_cancelled',
        promptId: 'prompt-2',
        stopHookActive: false,
        backgroundTasks: [RUNNING_TASK]
      })
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    } finally {
      server.stop()
    }
  })
})
