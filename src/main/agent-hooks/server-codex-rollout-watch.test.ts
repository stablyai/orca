// The Codex rollout watch reads the pane's rollout on a timer and publishes the row rebuilt from
// what it reads. It never replays a hook body, so it cannot re-run that body's side effects, and
// its life follows the pane's records rather than the identity of the row it last published.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function turnMarker(type: string, turnId: string): string {
  return line({
    type: 'event_msg',
    payload:
      type === 'turn_aborted'
        ? { type, turn_id: turnId, reason: 'interrupted' }
        : { type, turn_id: turnId }
  })
}

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Codex rollout watch', () => {
  let dir: string
  let rollout: string
  let server: AgentHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-rollout-watch-'))
    rollout = join(dir, 'rollout-parent.jsonl')
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(payload: Record<string, unknown>): Promise<void> {
    await expect(
      postHookEvent(
        server,
        buildBody({ session_id: 'root-session', transcript_path: rollout, ...payload }),
        '/hook/codex'
      )
    ).resolves.toMatchObject({ status: 204 })
  }

  it('settles a lost Interrupt after the row it last published was replaced', async () => {
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    // An OSC repaint of the same state swaps the row object without a hook.
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: 'go', agentType: 'codex' }
    })

    appendFileSync(rollout, turnMarker('turn_aborted', 'turn-1'))
    await vi.waitFor(
      () => {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  it("keeps a child whose start is more than a read back, since it never replays the last hook's reset", async () => {
    writeFileSync(
      rollout,
      turnMarker('task_started', 'turn-1') +
        line({
          type: 'event_msg',
          payload: { type: 'sub_agent_activity', agent_thread_id: CHILD_ID, kind: 'started' }
        })
    )
    writeFileSync(
      join(dir, `rollout-child-${CHILD_ID}.jsonl`),
      line({ type: 'event_msg', payload: { type: 'task_started' } })
    )
    await post({ hook_event_name: 'SessionStart', source: 'startup' })
    expect(server.getStatusSnapshot()[0]?.subagents).toEqual([
      expect.objectContaining({ id: CHILD_ID, state: 'working' })
    ])

    // More than one 1 MiB read of later rollout lines: a fresh read from the start would begin
    // past the child's start and lose it.
    const filler = line({ type: 'response_item', payload: { text: 'x'.repeat(1_000) } })
    appendFileSync(rollout, filler.repeat(1_200))
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: CHILD_ID, state: 'working' })]
    })
  })
  // A child Codex aborts fires no SubagentStop: Codex runs Stop hooks only for a turn that
  // completes. An embedded TUI exiting with a subagent still running aborts it this way.
  it('retires a hook-announced subagent once its own rollout records its abort', async () => {
    const childRollout = join(dir, `rollout-2026-09-27T10-00-00-${CHILD_ID}.jsonl`)
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    writeFileSync(childRollout, turnMarker('task_started', 'child-turn'))
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    await post({ hook_event_name: 'SubagentStart', agent_id: CHILD_ID, turn_id: 'child-turn' })
    await post({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: CHILD_ID, state: 'working' })]
    })

    appendFileSync(childRollout, turnMarker('turn_aborted', 'child-turn'))
    await vi.waitFor(
      () => {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
    expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  })
})

// Codex files a rollout under its own start date. A child's hooks name its rollout, so a child
// whose later turn comes days after it was spawned is still read from the right file.
describe("a Codex child's own rollout", () => {
  let home: string
  let server: AgentHookServer

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'codex-child-rollout-'))
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    rmSync(home, { recursive: true, force: true })
  })

  it('is read from the path its hooks name, not looked up by date folder', async () => {
    const parentDay = join(home, 'sessions', '2020', '01', '01')
    const childDay = join(home, 'sessions', '2020', '01', '02')
    mkdirSync(parentDay, { recursive: true })
    mkdirSync(childDay, { recursive: true })
    const rollout = join(parentDay, 'rollout-2020-01-01T10-00-00-root.jsonl')
    const childRollout = join(childDay, `rollout-2020-01-02T10-00-00-${CHILD_ID}.jsonl`)
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    writeFileSync(childRollout, turnMarker('task_started', 'child-turn'))
    const post = async (payload: Record<string, unknown>): Promise<void> => {
      await expect(
        postHookEvent(server, buildBody({ session_id: 'root-session', ...payload }), '/hook/codex')
      ).resolves.toMatchObject({ status: 204 })
    }
    await post({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'go',
      turn_id: 'turn-1',
      transcript_path: rollout
    })
    await post({ hook_event_name: 'Interrupt', turn_id: 'turn-1', transcript_path: rollout })
    // The child's later turn, today: neither the parent's day folder nor today's holds its file.
    await post({
      hook_event_name: 'PreToolUse',
      agent_id: CHILD_ID,
      turn_id: 'child-turn',
      transcript_path: childRollout,
      tool_name: 'Bash'
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: CHILD_ID, state: 'working' })]
    })

    // Codex aborted the child: no SubagentStop, only its rollout's record.
    appendFileSync(childRollout, turnMarker('turn_aborted', 'child-turn'))
    await vi.waitFor(
      () => {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })
})

describe('a Codex turn that ended while Orca was down', () => {
  let userDataPath: string
  let dir: string
  let rollout: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'codex-rollout-restart-'))
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'codex-rollout-restart-rollout-'))
    rollout = join(dir, 'rollout-parent.jsonl')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  async function runTurnThenStop(): Promise<void> {
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    await postHookEvent(
      first,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'go',
        session_id: 'root-session',
        transcript_path: rollout,
        turn_id: 'turn-1'
      }),
      '/hook/codex'
    )
    expect(first.getStatusSnapshot()[0]?.mainAgent).toMatchObject({ state: 'working' })
    first.flushStatusPersistSync()
    first.stop()
  }

  it('settles from the rollout once Orca starts again', async () => {
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    await runTurnThenStop()
    appendFileSync(rollout, turnMarker('turn_aborted', 'turn-1'))

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]).toMatchObject({
            state: 'done',
            interrupted: true,
            mainAgent: { state: 'done', outcome: 'cancellation' }
          })
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })

  it('settles a turn whose start is more than a read back once Orca starts again', async () => {
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    await runTurnThenStop()
    // More than one 1 MiB read of the turn's own work: the restart's read begins past its start.
    const filler = line({ type: 'response_item', payload: { text: 'x'.repeat(1_000) } })
    appendFileSync(rollout, filler.repeat(1_200) + turnMarker('turn_aborted', 'turn-1'))

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]).toMatchObject({
            state: 'done',
            interrupted: true,
            mainAgent: { state: 'done', outcome: 'cancellation' }
          })
        },
        { timeout: 3_000, interval: 50 }
      )
    } finally {
      server.stop()
    }
  })

  it('leaves a turn still open in the rollout working', async () => {
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    await runTurnThenStop()

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        mainAgent: { state: 'working' }
      })
      // The restored turn is still Codex's, so its end in the rollout settles it.
      appendFileSync(rollout, turnMarker('task_complete', 'turn-1'))
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]).toMatchObject({
            state: 'done',
            mainAgent: { state: 'done' }
          })
        },
        { timeout: 3_000, interval: 50 }
      )
      expect(server.getStatusSnapshot()[0]?.mainAgent?.outcome).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('does not bring back a row that was dropped while its turn was open', async () => {
    writeFileSync(rollout, turnMarker('task_started', 'turn-1'))
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    await postHookEvent(
      first,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'go',
        session_id: 'root-session',
        transcript_path: rollout,
        turn_id: 'turn-1'
      }),
      '/hook/codex'
    )
    // The CLI exited mid-turn: the row is dropped, keeping only its resume identity.
    first.dropStatusEntry(PANE)
    first.flushStatusPersistSync()
    first.stop()
    appendFileSync(rollout, turnMarker('turn_aborted', 'turn-1'))

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ providerSessionOnly: true, state: 'working' })
      ])
    } finally {
      server.stop()
    }
  })
})

describe('the Codex rollout watch on an SSH host', () => {
  let dir: string
  let rollout: string
  let desktop: AgentHookServer
  let relay: RelayAgentHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-rollout-watch-relay-'))
    rollout = join(dir, 'rollout-parent.jsonl')
    desktop = new AgentHookServer()
    await desktop.start({ env: 'production' })
    // The relay is the execution host: it reads the rollout and forwards what it publishes.
    relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (envelope) => desktop.ingestRemote(envelope, 'conn-1')
    })
    await relay.start()
  })

  afterEach(() => {
    relay.stop()
    desktop.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function postToRelay(payload: Record<string, unknown>): Promise<void> {
    const { port, token } = relay.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify(
        buildBody({ session_id: 'root-session', transcript_path: rollout, ...payload })
      )
    })
    expect(response.status).toBe(204)
  }

  it("mirrors the relay's reading on the desktop: the cancel, and a child the rollout finished", async () => {
    const childRollout = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      rollout,
      turnMarker('task_started', 'turn-1') +
        line({
          type: 'event_msg',
          payload: { type: 'sub_agent_activity', agent_thread_id: CHILD_ID, kind: 'started' }
        })
    )
    writeFileSync(childRollout, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    await postToRelay({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: CHILD_ID })]
    })

    // The Interrupt hook is lost; Codex still records the abort, and later the child's end.
    appendFileSync(rollout, turnMarker('turn_aborted', 'turn-1'))
    appendFileSync(childRollout, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
    await vi.waitFor(
      () => {
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
        expect(desktop.getStatusSnapshot()[0]?.subagents).toBeUndefined()
      },
      { timeout: 3_000, interval: 50 }
    )

    // A restarted relay knows nothing: its first child event carries no main agent and only its
    // own child, so the desktop's copy fills the rest and must match what the relay last read.
    const LATER_CHILD = 'child-after-relay-restart'
    desktop.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        hookEventName: 'SubagentStart',
        toolAgentId: LATER_CHILD,
        payload: {
          state: 'working',
          prompt: '',
          agentType: 'codex',
          subagents: [{ id: LATER_CHILD, state: 'working', startedAt: Date.now() }]
        }
      },
      'conn-1'
    )
    expect(desktop.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: LATER_CHILD })]
    })
  })
})
