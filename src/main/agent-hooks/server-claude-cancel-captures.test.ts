// A cancel never hides live work. These stories replay hook payloads recorded from Claude Code
// 2.1.280 over a real PTY (src/shared/__fixtures__/claude-cancel-*-hooks.jsonl, sidecars beside
// them) through the server's own HTTP ingress, and stand in for the renderer at the moments the
// driver pressed the cancel key. The captures established that a cancel fires no hook at all,
// kills only the foreground tool, and that every later Stop inventory matched the process table;
// the rules below are written against those payloads, not a remembered screen.
//
// The driver cancelled with Esc. Orca treats a bare Esc on a Claude pane as navigation (it also
// closes the /btw composer) and infers a cancel only from Ctrl+C, so each `cancel` record is
// replayed as the Ctrl+C inference the renderer would have sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  hookSupersedesCancel,
  loadCapture,
  type CapturedHook
} from './agent-cancel-capture.test-fixture'

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

/** The renderer's part of a cancel: capture the row as the baseline and, once the settle window
 *  passes with no hook, ask the server to infer the interrupt. */
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
      // The Stop that started the shell lists it; the main agent is settled and the row monitors.
      expect(hookAt(records, 4).payload.background_tasks).toEqual([
        expect.objectContaining({ type: 'shell', status: 'running', command: 'sleep 600' })
      ])
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })

      // A foreground turn starts on top of it and is cancelled mid-tool.
      await post(server, hookAt(records, 5))
      await post(server, hookAt(records, 6))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row(server).workingMode).toBeUndefined()

      const midTool = cancelLabelled(records, 'ESC-during-tool')
      expect(midTool.interrupted_painted).toBe(true)
      expect(midTool.hooks_before_next_typed_prompt).toEqual([])
      expect(hookSupersedesCancel(records, midTool)).toBe(false)
      expect(pressCtrlC(server)).toBe(true)
      // Why: the cancel is the main agent's verdict; the shell is the inventory's fact. The row shows
      // the shell, the verdict rides `mainAgent.outcome`, and `interrupted` (a done-row flag) is absent.
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).interrupted).toBeUndefined()

      // The next typed turn ends with the same inventory, and its plain Stop carries no verdict.
      await post(server, hookAt(records, 7))
      await post(server, hookAt(records, 8))
      expect(hookAt(records, 8).sleep_procs).toEqual([expect.stringContaining('sleep 600')])
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
      expect(row(server).mainAgent).not.toHaveProperty('outcome')

      // Cancelled again while streaming a reply, with no tool running.
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

      // The rig SIGKILLs the shell. That is not evidence yet: nothing has reported it.
      const kill = records.find((record) => record.kind === 'kill' && record.needle === 'sleep 600')
      expect(kill).toBeDefined()
      expect(row(server)).toMatchObject({ state: 'working', workingMode: 'monitoring' })

      // The CLI notices within a second and injects a task-notification turn whose Stop reports
      // an empty inventory; that Stop is what retires the shell.
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
      // A second shell, listed by its Stop.
      expect(hookAt(records, 20).payload.background_tasks).toEqual([
        expect.objectContaining({ command: 'sleep 500', status: 'running' })
      ])
      expect(row(server)).toMatchObject({ state: 'working', workingMode: 'monitoring' })
      await post(server, hookAt(records, 21))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      // The shell is killed, then the turn is cancelled. In the capture the CLI's death
      // notification landed 0.17 s after the cancel key, inside the renderer's settle window, so
      // the renderer never sent this inference; the notification turn superseded it.
      const afterKill = cancelLabelled(records, 'ESC-during-tool-after-kill')
      expect(afterKill.hooks_before_next_typed_prompt).toEqual([22, 23])
      expect(hookSupersedesCancel(records, afterKill)).toBe(true)

      // Had the inference won the race, the row would still read the last inventory: a process
      // death is not evidence until an inventory reports it, and the next Stop does so at once.
      expect(pressCtrlC(server)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      // The shell's death notification opens a real turn, so the cancel's verdict gives way to it.
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
    // No capture registered a cron (`session_crons` was `[]` on every Stop), so this story takes
    // the captured Stop and substitutes one entry; the listener reads only the list's length.
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
      // 2.1.280 launches the Agent tool asynchronously: the main agent Stops with the child running.
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

      // The main agent starts a foreground turn beside the child and is cancelled mid-tool.
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

      // The child's tool activity after the cancel keeps the row working and does not resurrect
      // the main agent; the next typed turn's Stop still lists the child.
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
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        await post(server, hookAt(records, index))
      }
      expect(pressCtrlC(server)).toBe(true)
      await post(server, hookAt(records, 9))
      expect(row(server)).toMatchObject({ state: 'working' })
      expect(row(server).turnCompletedAt).toBeUndefined()

      // Why: a completion stamp or a done without `interrupted` is what renderers announce as finished.
      for (const index of [4, 9]) {
        await post(server, {
          ...hookAt(records, index),
          payload: { ...hookAt(records, index).payload, hook_event_name: 'SubagentStop' }
        })
      }
      expect(row(server)).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).turnCompletedAt).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
