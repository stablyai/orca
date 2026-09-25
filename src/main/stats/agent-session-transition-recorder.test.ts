import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  AGENT_SESSION_MIRROR_LIMIT,
  AgentSessionTransitionRecorder,
  classifyAgentSessionTransition
} from './agent-session-transition-recorder'
import type { AgentSessionSink, AgentSessionStatusEvent } from './agent-session-transition-recorder'
import { StatsCollector } from './collector'
import { AgentHookServer, _internals } from '../agent-hooks/server'
import { PANE as STORE_PANE } from '../agent-hooks/server.test-fixtures'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const T = 1_700_000_000_000
const PANE = 'tab-1:pane-1'

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-recorder-'))
  vi.useFakeTimers({ now: T })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataDir, { recursive: true, force: true })
})

function hook(
  state: AgentSessionStatusEvent['payload']['state'],
  stateStartedAt: number,
  extra: Partial<AgentSessionStatusEvent> = {}
): AgentSessionStatusEvent {
  return {
    paneKey: PANE,
    connectionId: null,
    stateStartedAt,
    receivedAt: stateStartedAt,
    payload: { state },
    ...extra
  }
}

/** A row from a host that publishes the main agent fact beside the combined state. The recorder
 *  reads the combined row only; the fact rides along as it does on the real enriched payload. */
function mainAgentHook(
  row: {
    state: AgentSessionStatusEvent['payload']['state']
    workingMode?: 'monitoring'
    mainAgent: { state: AgentSessionStatusEvent['payload']['state']; stateStartedAt: number }
  },
  stateStartedAt: number,
  extra: Partial<AgentSessionStatusEvent> = {}
): AgentSessionStatusEvent {
  const payload = { state: row.state, workingMode: row.workingMode, mainAgent: row.mainAgent }
  return hook(row.state, stateStartedAt, { payload, ...extra })
}

function sink(): AgentSessionSink & {
  onAgentStart: Mock<AgentSessionSink['onAgentStart']>
  onAgentStop: Mock<AgentSessionSink['onAgentStop']>
} {
  return {
    onAgentStart: vi.fn<AgentSessionSink['onAgentStart']>(),
    onAgentStop: vi.fn<AgentSessionSink['onAgentStop']>()
  }
}

describe('AgentSessionTransitionRecorder', () => {
  it('counts a hook-only agent that never writes an agent-shaped terminal title', () => {
    // The regression this replaces: stats read OSC titles, so an agent whose CLI
    // reports only over hooks contributed nothing to either aggregate (#10201).
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('done', T + 180_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(180_000)
  })

  it('does not double-count a replayed status on reconnect', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    // Warm reconnect: the pane is already mirrored, so the replays are snapshots.
    recorder.onStatus(hook('working', T, { isReplay: true }))
    recorder.onStatus(hook('working', T, { isReplay: true }))
    recorder.onStatus(hook('working', T, { isReplay: true }))
    // Cold reconnect (app restart / new relay session): the replay is the first
    // thing this recorder sees for the pane, so the snapshot guard cannot help —
    // only the live gate stops it counting work that began in an earlier runtime.
    recorder.onStatus(hook('working', T, { paneKey: 'cold-pane', isReplay: true }))
    recorder.onStatus(hook('working', T, { paneKey: 'cold-pane', isReplay: true }))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
  })

  it('does not double-count a re-emitted live status mid-turn', () => {
    // Tool-progress events re-emit `working` many times per turn.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    for (let i = 0; i < 25; i++) {
      recorder.onStatus(hook('working', T))
    }
    recorder.onStatus(hook('done', T + 5_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(5_000)
  })

  it('never opens a session from a replayed or disk-restored working status', () => {
    // A replayed `working` describes work that began in an earlier runtime;
    // crediting it would mint a phantom spawn on every reconnect.
    const replayed = sink()
    new AgentSessionTransitionRecorder(replayed).onStatus(hook('working', T, { isReplay: true }))
    expect(replayed.onAgentStart).not.toHaveBeenCalled()

    const restored = sink()
    new AgentSessionTransitionRecorder(restored).onStatus(
      hook('working', T, { restoredUnconfirmed: true })
    )
    expect(restored.onAgentStart).not.toHaveBeenCalled()
  })

  it('still closes a live session when the terminating status arrives as a replay', () => {
    // How a client learns about a completion it missed while disconnected.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('done', T + 30_000, { isReplay: true }))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(30_000)
  })

  it('counts one session per turn across repeated working/done cycles', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('done', T + 10_000))
    recorder.onStatus(hook('working', T + 60_000))
    recorder.onStatus(hook('done', T + 75_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(25_000)
  })

  it('treats waiting and blocked as session boundaries, not agent work', () => {
    // Time parked on a permission prompt is the user's, not the agent's.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('waiting', T + 5_000))
    recorder.onStatus(hook('working', T + 300_000))
    recorder.onStatus(hook('blocked', T + 310_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(15_000)
  })

  it('ignores identity-only provider-session refreshes', () => {
    // These carry a state field but no turn-state transition; acting on them
    // would open a session from a resume-metadata write.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { providerSessionOnly: true }))
    expect(stats.getSummary().totalAgentsSpawned).toBe(0)

    recorder.onStatus(hook('working', T + 1_000))
    recorder.onStatus(hook('done', T + 2_000, { providerSessionOnly: true }))
    // The refresh must not close the live session either.
    expect(stats.getSummary().totalAgentTimeMs).toBe(0)

    recorder.onStatus(hook('done', T + 3_000))
    expect(stats.getSummary().totalAgentTimeMs).toBe(2_000)
  })

  it('closes an open session when its pane is torn down', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    vi.setSystemTime(T + 45_000)
    recorder.onCleared({ paneKey: PANE })

    expect(stats.getSummary().totalAgentTimeMs).toBe(45_000)
    expect(recorder.trackedPaneCount).toBe(0)
  })

  it('closes sessions on the dropped connection when an SSH batch clear lands', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { paneKey: 'a', connectionId: 'ssh-1' }))
    recorder.onStatus(hook('working', T, { paneKey: 'b', connectionId: 'ssh-2' }))
    recorder.onCleared({ transient: true, connectionId: 'ssh-1', clearedAt: T + 20_000 })

    expect(stats.getSummary().totalAgentTimeMs).toBe(20_000)
    expect(recorder.trackedPaneCount).toBe(1)
  })

  it('bounds the mirror and closes what it evicts', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { paneKey: 'oldest' }))
    for (let i = 0; i < AGENT_SESSION_MIRROR_LIMIT; i++) {
      recorder.onStatus(hook('working', T, { paneKey: `pane-${i}` }))
    }

    expect(recorder.trackedPaneCount).toBe(AGENT_SESSION_MIRROR_LIMIT)
    // The evicted pane's open session was closed out rather than leaked.
    expect(stats.getSummary().totalAgentsSpawned).toBe(AGENT_SESSION_MIRROR_LIMIT + 1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(0)
  })
})

describe('AgentSessionTransitionRecorder on rows that also carry the main agent fact', () => {
  // The stats ask "was an agent executing": the main agent's own turn, or a subagent still running
  // after the main agent settled. A background shell the settled main agent left behind is neither.
  const MAIN_AGENT_WORKING = { state: 'working' as const, stateStartedAt: T }

  it('stops the session when the main agent settles and only a watch loop holds the row working', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
    // The Stop hook: the row stays `working` (same clock) in monitoring mode; the main agent is done.
    recorder.onStatus(
      mainAgentHook(
        {
          state: 'working',
          workingMode: 'monitoring',
          mainAgent: { state: 'done', stateStartedAt: T + 20_000 }
        },
        T,
        { receivedAt: T + 20_000 }
      )
    )
    // Hours of dev server later, the shell exits and the row settles.
    recorder.onStatus(
      mainAgentHook(
        { state: 'done', mainAgent: { state: 'done', stateStartedAt: T + 20_000 } },
        T + 7_200_000
      )
    )

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(20_000)
  })

  it('keeps the session open while a subagent outlives the main agent, and closes it when the child settles', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
    recorder.onStatus(
      mainAgentHook(
        { state: 'working', mainAgent: { state: 'done', stateStartedAt: T + 10_000 } },
        T
      )
    )
    recorder.onStatus(
      mainAgentHook(
        { state: 'done', mainAgent: { state: 'done', stateStartedAt: T + 10_000 } },
        T + 90_000
      )
    )

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(90_000)
  })

  it('dates the stop by the evidence when a shell outlives the last subagent', () => {
    // Main agent done at +10s, its subagent finishes at +60s, a shell keeps the row in monitoring:
    // neither state clock moves at +60s, so the evidence clock is the edge.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)
    const mainAgentDone = { state: 'done' as const, stateStartedAt: T + 10_000 }

    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: mainAgentDone }, T))
    recorder.onStatus(
      mainAgentHook({ state: 'working', workingMode: 'monitoring', mainAgent: mainAgentDone }, T, {
        receivedAt: T + 60_000
      })
    )

    expect(stats.getSummary().totalAgentTimeMs).toBe(60_000)
  })

  it('dates a subagent reopening a monitoring row by the evidence, not the pinned row clock', () => {
    // The hook lane keeps the row's clock across a watch-loop mode change, so it still reads T,
    // the start of the main agent's turn; dating the reopen by it would bill the monitoring window.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)
    const mainAgentDone = { state: 'done' as const, stateStartedAt: T + 5_000 }

    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
    recorder.onStatus(
      mainAgentHook({ state: 'working', workingMode: 'monitoring', mainAgent: mainAgentDone }, T, {
        receivedAt: T + 5_000
      })
    )
    recorder.onStatus(
      mainAgentHook({ state: 'working', mainAgent: mainAgentDone }, T, {
        receivedAt: T + 600_000
      })
    )
    recorder.onStatus(
      mainAgentHook({ state: 'done', mainAgent: mainAgentDone }, T + 630_000, {
        receivedAt: T + 630_000
      })
    )

    expect(stats.getSummary().totalAgentTimeMs).toBe(35_000)
  })

  it('opens a new session dated by the observation when the main agent resumes after monitoring', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
    recorder.onStatus(
      mainAgentHook(
        {
          state: 'working',
          workingMode: 'monitoring',
          mainAgent: { state: 'done', stateStartedAt: T + 5_000 }
        },
        T,
        { receivedAt: T + 5_000 }
      )
    )
    // A task notification resumes the main agent; the row's own clock never moved off T.
    recorder.onStatus(
      mainAgentHook(
        { state: 'working', mainAgent: { state: 'working', stateStartedAt: T + 300_000 } },
        T,
        { receivedAt: T + 300_000 }
      )
    )
    recorder.onStatus(
      mainAgentHook(
        { state: 'done', mainAgent: { state: 'done', stateStartedAt: T + 312_000 } },
        T + 312_000
      )
    )

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(17_000)
  })

  it("never dates an edge by an SSH host's main agent clock", () => {
    // An SSH host stamps `mainAgent.stateStartedAt` with its own clock (an hour behind here), while
    // every other edge is dated by this host; mixing them would add the skew to the span.
    const skewed = new StatsCollector()
    const remote = new AgentSessionTransitionRecorder(skewed)
    remote.onStatus(
      mainAgentHook(
        { state: 'working', mainAgent: { state: 'working', stateStartedAt: T - 3_600_000 } },
        T
      )
    )
    remote.onStatus(
      mainAgentHook(
        { state: 'done', mainAgent: { state: 'done', stateStartedAt: T - 3_540_000 } },
        T + 60_000
      )
    )
    expect(skewed.getSummary().totalAgentTimeMs).toBe(60_000)
  })

  it('never dates a reopen before the close a fact-less OSC repaint caused', () => {
    // An OSC repaint to a different state carries no main agent fact and closes the span; the next
    // hook row restores the fact with its unchanged clock, which predates that close.
    const osc = new StatsCollector()
    const local = new AgentSessionTransitionRecorder(osc)
    local.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
    local.onStatus(hook('done', T + 10_000))
    local.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T + 12_000))
    local.onStatus(
      mainAgentHook(
        { state: 'done', mainAgent: { state: 'done', stateStartedAt: T + 20_000 } },
        T + 20_000
      )
    )
    expect(osc.getSummary().totalAgentTimeMs).toBe(18_000)
  })

  it.each([
    ['its own prompt', { state: 'waiting' as const, stateStartedAt: T + 30_000 }],
    // Codex/Claude: a child's approval prompt parks the row while the displaced main agent reads working.
    ["a child's approval prompt", MAIN_AGENT_WORKING]
  ])(
    'pauses the clock while the row waits on %s, dated by the row clock',
    (_, waitingMainAgent) => {
      const stats = new StatsCollector()
      const recorder = new AgentSessionTransitionRecorder(stats)

      recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
      // A reconnect replays the missed wait: the row clock is restamped at the edge, while the
      // evidence clock keeps the last observation before the gap.
      recorder.onStatus(
        mainAgentHook({ state: 'waiting', mainAgent: waitingMainAgent }, T + 30_000, {
          isReplay: true,
          receivedAt: T + 30_000,
          evidenceObservedAt: T + 20_000
        })
      )
      recorder.onStatus(
        mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T + 45_000)
      )
      recorder.onStatus(
        mainAgentHook(
          { state: 'done', mainAgent: { state: 'done', stateStartedAt: T + 60_000 } },
          T + 60_000
        )
      )

      expect(stats.getSummary().totalAgentsSpawned).toBe(2)
      expect(stats.getSummary().totalAgentTimeMs).toBe(45_000)
    }
  )

  it('never opens a session from a restored row whose main agent reads working', () => {
    const restored = sink()
    new AgentSessionTransitionRecorder(restored).onStatus(
      mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T, {
        restoredUnconfirmed: true
      })
    )
    expect(restored.onAgentStart).not.toHaveBeenCalled()

    const replayed = sink()
    new AgentSessionTransitionRecorder(replayed).onStatus(
      mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T, { isReplay: true })
    )
    expect(replayed.onAgentStart).not.toHaveBeenCalled()
  })

  it("reads an old host's monitoring row like a new host's: the watch loop stops the clock", () => {
    // Hosts that predate `mainAgent` already published `monitoring` only for a settled main agent.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(
      hook('working', T, {
        receivedAt: T + 20_000,
        payload: { state: 'working', workingMode: 'monitoring' }
      })
    )
    // The main agent resumes: the row's clock is still pinned to T.
    recorder.onStatus(hook('working', T, { receivedAt: T + 300_000 }))
    recorder.onStatus(hook('done', T + 310_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(30_000)
  })

  it('dates the first live row after a restored one by the evidence, not the restored clock', () => {
    // A live hook that repeats a hydrated `working` keeps the row clock from the earlier runtime.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T - 3_600_000, { receivedAt: T }))
    recorder.onStatus(hook('done', T + 60_000))

    expect(stats.getSummary().totalAgentTimeMs).toBe(60_000)
  })
})

describe('AgentSessionTransitionRecorder fed by the status store', () => {
  it('dates a live start on a hydrated row by this runtime, not the persisted state clock', async () => {
    // An OSC row carries no main agent fact; its live repeat keeps the persisted `stateStartedAt`.
    vi.useRealTimers()
    _internals.resetCachesForTests()
    const hookDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-recorder-hooks-'))
    const osc = {
      paneKey: STORE_PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working' as const, prompt: 'build', agentType: 'claude' as const }
    }
    const now = vi.spyOn(Date, 'now').mockReturnValue(T)
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: hookDataDir })
    first.ingestTerminalStatus(osc)
    await first.flushStatusPersist()
    await first.stop()

    now.mockReturnValue(T + 3_600_000)
    const server = new AgentHookServer()
    const starts = sink()
    const recorder = new AgentSessionTransitionRecorder(starts)
    try {
      await server.start({ env: 'production', userDataPath: hookDataDir })
      server.subscribeEnrichedStatus((enriched) => recorder.onStatus(enriched))
      server.ingestTerminalStatus({ ...osc, payload: { ...osc.payload, toolName: 'Bash' } })
      expect(starts.onAgentStart).toHaveBeenCalledWith(STORE_PANE, T + 3_600_000, undefined, 'wt-1')
    } finally {
      await server.stop()
      now.mockRestore()
      rmSync(hookDataDir, { recursive: true, force: true })
    }
  })
})

describe('classifyAgentSessionTransition', () => {
  it('treats an unchanged answer as a snapshot, never a transition', () => {
    expect(
      classifyAgentSessionTransition({ executing: true, open: true }, hook('working', T))
    ).toBe('none')
    expect(classifyAgentSessionTransition({ executing: false, open: false }, hook('done', T))).toBe(
      'none'
    )
  })

  it('opens only on a live working edge', () => {
    expect(classifyAgentSessionTransition(undefined, hook('working', T))).toBe('start')
    expect(classifyAgentSessionTransition(undefined, hook('working', T, { isReplay: true }))).toBe(
      'none'
    )
  })

  it('closes only a session it opened', () => {
    expect(classifyAgentSessionTransition({ executing: true, open: true }, hook('done', T))).toBe(
      'stop'
    )
    expect(classifyAgentSessionTransition({ executing: true, open: false }, hook('done', T))).toBe(
      'none'
    )
  })
})
