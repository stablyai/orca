// A Codex cancel never hides live work — and never strands a settled row. These stories replay
// hook payloads recorded from Codex CLI 0.156.1 over a real PTY
// (src/shared/__fixtures__/codex-cancel-bg-subagent-hooks.jsonl, sidecar beside it) through the
// server's own HTTP ingress, and stand in for the renderer at the moments the driver pressed the
// cancel key. The capture established that Ctrl+C and Esc paint "Interrupted" but fire no hook at
// all, that the subagent and every background terminal survive the cancel (the interrupted
// foreground command becomes a background terminal), that the subagent's own end still fires its
// PostToolUse and SubagentStop, and that a background terminal's start completes no tool call and
// its end fires nothing — so the roster is the only child evidence this lane has.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  cancelLabelled,
  endedNaturally,
  hookAt,
  hooksBetween,
  hookSupersedesCancel,
  loadCapture,
  type CapturedHook
} from './agent-cancel-capture.test-fixture'
import type { AgentInterruptInputIntent } from '../../shared/agent-interrupt-intent'
import { captureAgentInterruptTurnBaseline } from '../../shared/agent-interrupt-turn-baseline'

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
  await expect(
    postHookEvent(server, buildBody(hook.payload), '/hook/codex')
  ).resolves.toMatchObject({ status: 204 })
}

/** The renderer's part of a cancel: capture the row as the baseline at the keypress and ask the
 *  server to infer the interrupt (Ctrl+C after the settle window; a Codex Esc flushes immediately). */
function pressCancel(
  server: AgentHookServer,
  intent: AgentInterruptInputIntent,
  baseline = row(server)
): boolean {
  const turn = captureAgentInterruptTurnBaseline({ ...baseline, updatedAt: baseline.receivedAt })
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: turn.updatedAt,
    baselineStateStartedAt: turn.stateStartedAt,
    baselinePrompt: turn.prompt,
    baselineAgentType: 'codex',
    ...(turn.mainAgentStateStartedAt !== undefined
      ? { baselineMainAgentStateStartedAt: turn.mainAgentStateStartedAt }
      : {}),
    intent
  })
}

describe('a Codex cancel with a live subagent and background terminals (captured)', () => {
  const records = loadCapture('codex-cancel-bg-subagent-hooks')

  it('reads the main agent cancelled at once, keeps the subagent, and settles to done on its SubagentStop', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        await post(server, hookAt(records, index))
      }
      // The turn runs a foreground tool beside a spawned subagent; the row folds both as working.
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'working' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })

      // Ctrl+C mid-turn: "Interrupted" painted, and no hook — not then, not ever for this turn.
      const ctrlC = cancelLabelled(records, 'ctrl-c-mid-turn-with-children')
      expect(ctrlC.interrupted_painted).toBe(true)
      expect(ctrlC.hooks_before_next_typed_prompt).toEqual([])
      expect(hookSupersedesCancel(records, ctrlC)).toBe(false)
      expect(pressCancel(server, 'ctrl-c')).toBe(true)
      // The cancel is the main agent's verdict; the roster keeps the row working. `interrupted`
      // is a done-row flag, so the working row carries the verdict on `mainAgent.outcome` only.
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })
      expect(row(server).workingMode).toBeUndefined()
      expect(row(server).interrupted).toBeUndefined()

      // The next typed turn withdraws the verdict; Esc mid-tool re-infers it the same way.
      await post(server, hookAt(records, 9))
      expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(row(server).mainAgent).not.toHaveProperty('outcome')
      await post(server, hookAt(records, 10))
      const esc = cancelLabelled(records, 'esc-mid-turn-with-children')
      expect(esc.interrupted_painted).toBe(true)
      expect(esc.background_terminal_on_screen).toBe(true)
      expect(hookSupersedesCancel(records, esc)).toBe(false)
      expect(pressCancel(server, 'plain-escape')).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      // The subagent's own tool completion keeps the row working without resurrecting the main agent.
      await post(server, hookAt(records, 11))
      expect(hookAt(records, 11).payload.agent_id).toBeDefined()
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })

      // Its SubagentStop drains the roster: the row settles done with the verdict and no
      // completion stamp, while the capture's ps shows the background terminal still running —
      // Codex emits no evidence for background terminals, so the row cannot honestly hold on them.
      const subagentStop = hookAt(records, 12)
      expect(subagentStop.payload.hook_event_name).toBe('SubagentStop')
      expect(subagentStop.sleep_procs).toEqual([expect.stringContaining('sleep 240')])
      await post(server, subagentStop)
      expect(row(server)).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(row(server).workingMode).toBeUndefined()
      expect(row(server).turnCompletedAt).toBeUndefined()

      // The background terminals' natural ends fire nothing: the capture has no hook in the 30 s
      // after the backgrounded foreground command died, nor in the 75 s settle after the last
      // terminal died. The next Stop belongs to the next typed turn and carries no verdict.
      const backgroundedForegroundEnd = endedNaturally(records, 'sleep 90')
      expect(
        hooksBetween(records, backgroundedForegroundEnd.t, backgroundedForegroundEnd.t + 30)
      ).toHaveLength(0)
      const lastTerminalEnd = endedNaturally(records, 'sleep 240')
      expect(hooksBetween(records, lastTerminalEnd.t, lastTerminalEnd.t + 75)).toHaveLength(0)
      await post(server, hookAt(records, 13))
      await post(server, hookAt(records, 14))
      expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      expect(row(server).mainAgent).not.toHaveProperty('outcome')
      expect(row(server).interrupted).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})

describe('a Codex Ctrl+C whose settle window a subagent hook lands in (captured hooks)', () => {
  const records = loadCapture('codex-cancel-bg-subagent-hooks')

  it('still cancels the main agent and settles done on the SubagentStop', async () => {
    const server = await startServer()
    try {
      for (const index of [0, 1, 2, 3, 4, 5, 6]) {
        await post(server, hookAt(records, index))
      }
      const keypressRow = row(server)
      expect(keypressRow).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      // The subagent's own PreToolUse lands between the keypress and the settle-window flush.
      const childPreToolUse = hookAt(records, 7)
      expect(childPreToolUse.payload).toMatchObject({ hook_event_name: 'PreToolUse' })
      expect(childPreToolUse.payload.agent_id).toBeDefined()
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(keypressRow.receivedAt))
      await post(server, childPreToolUse)
      expect(row(server).receivedAt).not.toBe(keypressRow.receivedAt)

      expect(pressCancel(server, 'ctrl-c', keypressRow)).toBe(true)
      expect(row(server)).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })

      await post(server, hookAt(records, 11))
      await post(server, hookAt(records, 12))
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

describe('a relayed Codex cancel with a live subagent', () => {
  it('folds the inferred cancel with the roster main reconciles for the relayed pane', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'long task', agentType: 'codex' }
        },
        'conn-1'
      )
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'SubagentStart',
          toolAgentId: 'agent-1',
          payload: {
            state: 'working',
            prompt: 'long task',
            agentType: 'codex',
            subagents: [{ id: 'agent-1', state: 'working', startedAt: 900 }]
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]
      expect(baseline).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'long task',
          baselineAgentType: 'codex',
          intent: 'ctrl-c'
        })
      ).toBe(true)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' },
        subagents: [expect.objectContaining({ id: 'agent-1', state: 'working' })]
      })
      expect(server.getStatusSnapshot()[0].interrupted).toBeUndefined()

      // The relay never learned of the cancel, so its SubagentStop still restates `working`; the
      // reconcile against main's marked record is what settles the row.
      vi.setSystemTime(20_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hookEventName: 'SubagentStop',
          toolAgentId: 'agent-1',
          payload: { state: 'working', prompt: 'long task', agentType: 'codex' }
        },
        'conn-1'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
