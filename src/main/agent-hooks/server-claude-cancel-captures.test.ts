// Replay Claude Code 2.1.280 PTY captures; recorded Esc cancellations stand in for Orca Ctrl+C inference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS } from '../../shared/claude-owed-task-notifications'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  hookSupersedesCancel,
  loadCapture,
  type CapturedHook
} from './claude-cancel-capture.test-fixture'

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

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  return server
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

async function post(server: AgentHookServer, hook: CapturedHook): Promise<void> {
  await expect(postHookEvent(server, buildBody(hook.payload))).resolves.toMatchObject({
    status: 204
  })
}

/** Infer cancellation against the captured baseline after a hook-free settle window. */
function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

describe('a Claude cancel with a background shell (captured)', () => {
  const records = loadCapture('claude-cancel-shell-hooks')

  it('keeps a shell the cancelled turn left running as monitoring, in both cancel shapes', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4]) {
        await post(server, hookAt(records, index))
      }
      // The initial Stop retains the background shell as monitoring work.
      expect(hookAt(records, 4).payload.background_tasks).toEqual([
        expect.objectContaining({ type: 'shell', status: 'running', command: 'sleep 600' })
      ])
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })

      // Cancel a foreground turn while the shell survives.
      await post(server, hookAt(records, 5))
      await post(server, hookAt(records, 6))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row(server).workingMode).toBeUndefined()

      const midTool = cancelLabelled(records, 'ESC-during-tool')
      expect(midTool.interrupted_painted).toBe(true)
      expect(midTool.hooks_before_next_typed_prompt).toEqual([])
      expect(hookSupersedesCancel(records, midTool)).toBe(false)
      expect(pressCtrlC(server)).toBe(true)
      // Main-agent cancellation does not override live shell inventory or mark the whole row interrupted.
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).interrupted).toBeUndefined()

      // A later plain Stop carries the same inventory without a cancellation verdict.
      await post(server, hookAt(records, 7))
      await post(server, hookAt(records, 8))
      expect(hookAt(records, 8).sleep_procs).toEqual([expect.stringContaining('sleep 600')])
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
      expect(row(server).mainAgent).not.toHaveProperty('outcome')

      // Cancel again while streaming, without a foreground tool.
      await post(server, hookAt(records, 9))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      const midStream = cancelLabelled(records, 'ESC-during-stream')
      expect(hookSupersedesCancel(records, midStream)).toBe(false)
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    } finally {
      server.stop()
    }
  })

  it('lets the shell leave only when an inventory omits it, and then settles to done', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6]) {
        await post(server, hookAt(records, index))
      }
      expect(pressCtrlC(server)).toBe(true)
      for (const index of [7, 8, 9]) {
        await post(server, hookAt(records, index))
      }
      expect(pressCtrlC(server)).toBe(true)
      await post(server, hookAt(records, 10))
      await post(server, hookAt(records, 11))
      expect(row(server)).toMatchObject({ state: 'working', workingMode: 'monitoring' })

      // SIGKILL is not server evidence until a hook reports the changed inventory.
      const kill = records.find((record) => record.kind === 'kill' && record.needle === 'sleep 600')
      expect(kill).toBeDefined()
      expect(row(server)).toMatchObject({ state: 'working', workingMode: 'monitoring' })

      // The notification turn reports empty inventory and retires the shell.
      const notification = hookAt(records, 12)
      expect(notification.payload.hook_event_name).toBe('UserPromptSubmit')
      expect(String(notification.payload.prompt)).toContain('<task-notification>')
      await post(server, notification)
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      const allClear = hookAt(records, 13)
      expect(allClear.payload).toMatchObject({ hook_event_name: 'Stop', background_tasks: [] })
      expect(allClear.sleep_procs).toEqual([])
      await post(server, allClear)
      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      expect(row(server).workingMode).toBeUndefined()
      expect(row(server).interrupted).toBeUndefined()
      expect(row(server).mainAgent).not.toHaveProperty('outcome')
    } finally {
      server.stop()
    }
  })

  it('reads the last inventory until the next one, even for a cancel right after an external kill', async () => {
    const server = await startServer()
    try {
      for (const index of [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20
      ]) {
        await post(server, hookAt(records, index))
      }
      expect(hookAt(records, 20).payload.background_tasks).toEqual([
        expect.objectContaining({ command: 'sleep 500', status: 'running' })
      ])
      expect(row(server)).toMatchObject({ state: 'working', workingMode: 'monitoring' })
      await post(server, hookAt(records, 21))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      // The death notification arrived inside the settle window, superseding inferred cancellation.
      const afterKill = cancelLabelled(records, 'ESC-during-tool-after-kill')
      expect(afterKill.hooks_before_next_typed_prompt).toEqual([22, 23])
      expect(hookSupersedesCancel(records, afterKill)).toBe(true)

      // If inference wins, retain the last inventory until the next Stop reports the death.
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      const notification = hookAt(records, 22)
      expect(String(notification.payload.prompt)).toContain('<task-notification>')
      await post(server, notification)
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row(server).workingMode).toBeUndefined()
      const settled = hookAt(records, 23)
      expect(settled.payload).toMatchObject({ hook_event_name: 'Stop', background_tasks: [] })
      await post(server, settled)
      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      expect(row(server).workingMode).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('keeps a scheduled session check the cancelled turn left registered as monitoring', async () => {
    // Captures contain no crons; substitute one into a recorded Stop to exercise scheduled monitoring.
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3]) {
        await post(server, hookAt(records, index))
      }
      const stopWithCron = hookAt(records, 4)
      expect(stopWithCron.payload.session_crons).toEqual([])
      await post(server, {
        ...stopWithCron,
        payload: {
          ...stopWithCron.payload,
          background_tasks: [],
          session_crons: [{ id: 'cron-1', description: 'synthetic: check the build' }]
        }
      })
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
      await post(server, hookAt(records, 5))
      await post(server, hookAt(records, 6))
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(true)
    } finally {
      server.stop()
    }
  })
})

describe('a Claude cancel with a live subagent (captured)', () => {
  const records = loadCapture('claude-cancel-subagent-hooks')

  it('keeps the subagent working while the main agent reads cancelled', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5]) {
        await post(server, hookAt(records, index))
      }
      // Claude 2.1.280 launches Agent asynchronously and Stops while the child runs.
      expect(hookAt(records, 3).payload.tool_response).toMatchObject({ status: 'async_launched' })
      expect(hookAt(records, 5).payload.background_tasks).toEqual([
        expect.objectContaining({ type: 'subagent', status: 'running' })
      ])
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })
      expect(row(server).workingMode).toBeUndefined()

      // Cancel foreground work while the child survives.
      for (const index of [6, 7, 8]) {
        await post(server, hookAt(records, index))
      }
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      const cancel = cancelLabelled(records, 'ESC-during-tool-with-bg-agent')
      expect(cancel.interrupted_painted).toBe(true)
      expect(hookSupersedesCancel(records, cancel)).toBe(false)
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })
      expect(row(server).workingMode).toBeUndefined()

      // Child activity preserves working status without reviving the cancelled main agent.
      await post(server, hookAt(records, 9))
      expect(hookAt(records, 9).payload.agent_id).toBeDefined()
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      await post(server, hookAt(records, 10))
      await post(server, hookAt(records, 11))
      expect(hookAt(records, 11).sleep_procs).toHaveLength(2)
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })
      expect(row(server).mainAgent).not.toHaveProperty('outcome')
    } finally {
      server.stop()
    }
  })

  it('settles the drained row as a stopped turn, never a completed one', async () => {
    // Real loopback POSTs need fake time to advance.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
    })
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        await post(server, hookAt(records, index))
      }
      expect(pressCtrlC(server)).toBe(true)
      await post(server, hookAt(records, 9))
      expect(row(server)).toMatchObject({ state: 'working' })
      expect(row(server).turnCompletedAt).toBeUndefined()

      // Completion stamps and non-interrupted done rows trigger renderer completion announcements.
      for (const index of [4, 9]) {
        await post(server, {
          ...hookAt(records, index),
          payload: { ...hookAt(records, index).payload, hook_event_name: 'SubagentStop' }
        })
      }
      // Wait unstamped for the launched child's owed notification or its lease expiry.
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).turnCompletedAt).toBeUndefined()

      vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)
      expect(row(server)).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).turnCompletedAt).toBeUndefined()
    } finally {
      server.stop()
      vi.useRealTimers()
    }
  })
})
