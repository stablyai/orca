// Grok 1.0.41, measured (src/shared/__fixtures__/grok-cancel-subagent-dialog-hooks.jsonl):
// no keypress cancels a Grok turn by itself — Esc only paints a toast, and Ctrl+C with subagents
// running opens a dialog that can be answered "continue" — so Orca never infers a Grok cancel
// from keys. Every real cancel fires Grok's own `stop_cancelled`, which carries NO backgroundTasks
// inventory, so it folds with the inventory Grok last reported. Ctrl+C at the idle prompt kills
// no background task.
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

  it('refuses a key-inferred cancel mid-turn and folds the inventory-less stop_cancelled', async () => {
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

      // Why: Ctrl+C mid-turn can open Grok's subagents dialog and cancel nothing; only Grok's
      // own hook is cancel evidence.
      const before = row(server)
      expect(pressCtrlC(server)).toBe(false)
      expect(row(server)).toEqual(before)

      // Grok's real stop_cancelled carries no backgroundTasks key; the fold keeps the
      // inventory the last `stop` reported instead of settling the row.
      await postGrokHook(server, {
        hookEventName: 'stop_cancelled',
        promptId: 'prompt-2',
        reason: 'user_interrupt',
        cancelledBy: 'user',
        cancelTrigger: 'ctrl_c'
      })
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      // Why: `interrupted` restates the verdict only on a settled row; a held-open row carries it on `mainAgent.outcome`.
      expect(row(server).interrupted).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  // Measured live: a subagent spawned in the very turn that gets cancelled appears in NO stop
  // inventory yet; only its SubagentStart hook can put it in the fold.
  it('folds a subagent the cancelled turn itself spawned, and settles when it ends', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postGrokHook(server, {
        hookEventName: 'user_prompt_submit',
        promptId: 'prompt-1',
        prompt: 'spawn a subagent then run a command'
      })
      await postGrokHook(server, {
        hookEventName: 'subagent_start',
        subagentId: 'sub-1',
        subagentType: 'general-purpose'
      })
      await postGrokHook(server, {
        hookEventName: 'stop_cancelled',
        promptId: 'prompt-1',
        reason: 'user_interrupt',
        cancelledBy: 'user',
        cancelTrigger: 'ctrl_c'
      })
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      // The subagent's own end (child session id equals the subagentId) settles the row.
      await postGrokHook(server, {
        hookEventName: 'session_end',
        reason: 'shutdown',
        subagentType: 'general-purpose',
        sessionId: 'sub-1'
      })
      expect(row(server)).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    } finally {
      server.stop()
    }
  })

  // Grok 1.0.41: a shell started in the turn that gets cancelled is in no `stop` inventory yet,
  // survives the cancel, and its end wakes no follow-up turn; only its own start and end hooks
  // bracket it. Shapes copied from the captured PostToolUse (hook 7) and task_complete (hook 18).
  it('folds a shell the cancelled turn itself started, and settles on its task_complete', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postGrokHook(server, {
        hookEventName: 'user_prompt_submit',
        promptId: 'prompt-1',
        prompt: 'start a background shell then run a command'
      })
      const started = {
        type: 'BackgroundTaskStarted',
        task_id: 'task-7',
        task_type: 'bash',
        status: 'running',
        command: 'sleep 375'
      }
      await postGrokHook(server, {
        hookEventName: 'post_tool_use',
        toolName: 'run_terminal_command',
        toolUseId: 'call-1',
        toolInput: { command: 'sleep 375', background: true },
        toolResult: started,
        hook_event_name: 'PostToolUse',
        tool_name: 'run_terminal_command',
        tool_response: started
      })
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row(server).workingMode).toBeUndefined()

      await postGrokHook(server, {
        hookEventName: 'stop_cancelled',
        promptId: 'prompt-1',
        reason: 'user_interrupt',
        cancelledBy: 'user',
        cancelTrigger: 'ctrl_c'
      })
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      await postGrokHook(server, {
        hookEventName: 'notification',
        notificationType: 'task_complete',
        message: 'Background task completed: task-7',
        level: 'info'
      })
      expect(row(server)).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    } finally {
      server.stop()
    }
  })
})

describe('a plain Grok stop a task holds open', () => {
  it('earns its turn stamp at the idle restatement and pairs the all-clear with it', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await startTaskThenSettle(server)
      expect(row(server).turnCompletedAt).toBeUndefined()

      await postGrokHook(server, { hookEventName: 'notification', notificationType: 'idle_prompt' })
      expect(row(server)).toMatchObject({ state: 'working', workingMode: 'monitoring' })
      const turnCompletedAt = row(server).turnCompletedAt
      expect(turnCompletedAt).toEqual(expect.any(Number))
      expect(turnCompletedAt).toBe(row(server).mainAgent?.stateStartedAt)

      await postGrokHook(server, {
        hookEventName: 'notification',
        notificationType: 'task_complete',
        message: 'Background task completed: task-1',
        level: 'info'
      })
      expect(row(server)).toMatchObject({ state: 'done', turnCompletedAt })
      expect(row(server).interrupted).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
