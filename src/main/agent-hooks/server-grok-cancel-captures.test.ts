// A cancel never hides live work. These stories replay hook payloads recorded from Grok 1.0.41
// over a real PTY (src/shared/__fixtures__/grok-cancel-subagent-dialog-hooks.jsonl, sidecar
// beside it) through the server's own HTTP ingress, and stand in for the renderer at the moments
// the driver pressed a cancel key. The capture established that Esc mid-turn fires no hook (the
// turn keeps running), that Ctrl+C with subagents running opens a dialog and fires nothing until
// answered, that `stop_cancelled` carries NO backgroundTasks inventory, and that a killed
// subagent's only trace is its own SessionEnd (sessionId equal to SubagentStart's subagentId);
// the rules below are written against those payloads, not a remembered screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  loadCapture,
  type CapturedHook
} from './agent-cancel-capture.test-fixture'

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

const records = loadCapture('grok-cancel-subagent-dialog-hooks')

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
  await expect(postHookEvent(server, buildBody(hook.payload), '/hook/grok')).resolves.toMatchObject(
    { status: 204 }
  )
}

async function replay(server: AgentHookServer, indices: number[]): Promise<void> {
  for (const index of indices) {
    await post(server, hookAt(records, index))
  }
}

function shellTaskId(payload: Record<string, unknown>): string {
  const tasks = payload.backgroundTasks
  const shell = Array.isArray(tasks) ? tasks.find((task) => task?.type === 'shell') : undefined
  if (typeof shell?.id !== 'string') {
    throw new Error('the capture lists no shell task')
  }
  return shell.id
}

/** The renderer's part of a cancel: capture the row as the baseline and ask the server to infer
 *  the interrupt, exactly as it would after the settle window. */
function pressCancelKey(server: AgentHookServer, intent: 'plain-escape' | 'ctrl-c'): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'grok',
    intent
  })
}

describe('a Grok cancel with a background shell and subagent (captured)', () => {
  it('never marks the row from a keypress, and folds every turn end with the reported inventory', async () => {
    const server = await startServer()
    try {
      // Turn 1 starts a background shell and a background subagent, then ends. Its `stop`
      // (hook 8) lists both; the subagent is agent work, so the settled lead reads working.
      await replay(server, [0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(hookAt(records, 8).payload.backgroundTasks).toMatchObject([
        { type: 'shell', status: 'running' },
        { type: 'subagent', status: 'running' }
      ])
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

      // Turn 2 runs a foreground command; the lead turn owns the row again.
      await replay(server, [9, 10, 11, 12])
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      // Esc mid-turn: the capture shows no main-session hook and live processes — the turn kept
      // running. The renderer's plain-escape inference must be refused.
      const escCancel = cancelLabelled(records, 'ESC-mid-turn')
      expect(escCancel.interrupted_painted).toBe(false)
      const beforeEsc = row(server)
      expect(pressCancelKey(server, 'plain-escape')).toBe(false)
      expect(row(server)).toEqual(beforeEsc)

      // Ctrl+C mid-turn: Grok opened its "Subagents are still running" dialog and fired nothing.
      // The keypress proves nothing either way; the dialog was answered "Continue to run".
      expect(pressCancelKey(server, 'ctrl-c')).toBe(false)
      expect(row(server)).toEqual(beforeEsc)

      // The subagent's own poll (hook 13) maps to nothing.
      await replay(server, [13])
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      // Grok's own stop_cancelled (hook 14) carries NO inventory; ps in the capture shows the
      // shell and subagent still alive. The cancel verdict lands on the main agent while the
      // inventory Grok last reported keeps the row working.
      expect(hookAt(records, 14).payload).not.toHaveProperty('backgroundTasks')
      expect(hookAt(records, 14).sleep_procs).toHaveLength(2)
      await replay(server, [14])
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      // Why: `interrupted` restates the verdict only on a settled row; the held-open row carries it on `mainAgent.outcome`.
      expect(row(server).interrupted).toBeUndefined()
      expect(row(server).workingMode).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it("a killed subagent's own SessionEnd re-derives the row the inventory held open", async () => {
    const server = await startServer()
    try {
      await replay(server, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])

      // Turn 3, then Ctrl+C answered "Stop running" (default): the same inventory-less
      // stop_cancelled. Grok has not yet told the pane the subagent died, so the row still works.
      await replay(server, [15, 16])
      expect(pressCancelKey(server, 'ctrl-c')).toBe(false)
      await replay(server, [17])
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      // The child's own task_complete (hook 18) names a task the pane's inventory never held.
      await replay(server, [18])
      expect(row(server)).toMatchObject({ state: 'working' })

      // The subagent's SessionEnd (hook 19) drops it from the inventory; only the background
      // shell remains, so the cancelled row re-derives to monitoring — through the cancel-verdict
      // hold, which releases on Grok's own settled main agent. The child's session id must not
      // replace the pane's resume identity.
      expect(hookAt(records, 19).payload.subagentType).toBe('general-purpose')
      await replay(server, [19])
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).providerSession?.id).toBe(hookAt(records, 8).payload.session_id)

      // The main session's own end settles the pane whatever the inventory says.
      await replay(server, [20])
      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    } finally {
      server.stop()
    }
  })

  // Why: a cancel arms Grok's wake barrier, so the surviving shell's end runs no follow-up turn
  // and no `stop`; its own task_complete Notification is the only hook that says it is gone.
  it("the surviving shell's own task_complete settles the cancelled row", async () => {
    const server = await startServer()
    try {
      await replay(
        server,
        Array.from({ length: 20 }, (_, index) => index)
      )
      expect(row(server)).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      // Grok's task_complete for the main session's shell: the captured child notification's
      // shape (hook 18), re-addressed to the main session and the shell hook 8 listed.
      const main = hookAt(records, 17).payload
      const shellId = shellTaskId(hookAt(records, 8).payload)
      await post(server, {
        ...hookAt(records, 18),
        payload: {
          ...hookAt(records, 18).payload,
          sessionId: main.sessionId,
          session_id: main.session_id,
          transcriptPath: main.transcriptPath,
          transcript_path: main.transcript_path,
          message: `Background task completed: ${shellId}`
        }
      })
      expect(row(server)).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).workingMode).toBeUndefined()
      expect(row(server).providerSession?.id).toBe(main.session_id)
    } finally {
      server.stop()
    }
  })
})
