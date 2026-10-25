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

/** Model combined hook state with main-agent evidence alongside it. */
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
    // #10201: hook-only agents must contribute despite absent OSC titles.
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
    // Warm reconnect rows repeat mirrored snapshots.
    recorder.onStatus(hook('working', T, { isReplay: true }))
    recorder.onStatus(hook('working', T, { isReplay: true }))
    recorder.onStatus(hook('working', T, { isReplay: true }))
    // Cold replay has no prior mirror; only live-event gating prevents counting work from the earlier runtime.
    recorder.onStatus(hook('working', T, { paneKey: 'cold-pane', isReplay: true }))
    recorder.onStatus(hook('working', T, { paneKey: 'cold-pane', isReplay: true }))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
  })

  it('does not double-count a re-emitted live status mid-turn', () => {
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
    // Historical working replay must not mint a new spawn on reconnect.
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
    // Permission-wait time belongs to the user, not agent execution.
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
    // Identity refreshes carry state but no execution transition; never open from resume metadata alone.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { providerSessionOnly: true }))
    expect(stats.getSummary().totalAgentsSpawned).toBe(0)

    recorder.onStatus(hook('working', T + 1_000))
    recorder.onStatus(hook('done', T + 2_000, { providerSessionOnly: true }))
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
    expect(stats.getSummary().totalAgentsSpawned).toBe(AGENT_SESSION_MIRROR_LIMIT + 1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(0)
  })
})

describe('AgentSessionTransitionRecorder on rows that also carry the main agent fact', () => {
  // Count main/subagent execution, excluding background shells left by a settled agent.
  const MAIN_AGENT_WORKING = { state: 'working' as const, stateStartedAt: T }

  it('stops the session when the main agent settles and only a watch loop holds the row working', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
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
    // Subagent completion can leave monitoring state/clock unchanged; date the stop from evidence.
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
    // Watch-loop changes retain turn-start clock; reopening from it would bill the monitoring gap.
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
    // Main-agent resume keeps the old row clock; use current evidence.
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
    // Remote main-agent clocks may skew by hours; all duration edges need this host's clocks.
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
    // OSC can close the span without main-agent evidence; its restored fact has an older unchanged clock.
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
    // Child approval can park the row while the displaced main agent still says working.
    ["a child's approval prompt", MAIN_AGENT_WORKING]
  ])(
    'pauses the clock while the row waits on %s, dated by the row clock',
    (_, waitingMainAgent) => {
      const stats = new StatsCollector()
      const recorder = new AgentSessionTransitionRecorder(stats)

      recorder.onStatus(mainAgentHook({ state: 'working', mainAgent: MAIN_AGENT_WORKING }, T))
      // Reconnect restamps row timing but preserves pre-gap evidence time.
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
    // Older hosts already used monitoring only for settled main agents.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(
      hook('working', T, {
        receivedAt: T + 20_000,
        payload: { state: 'working', workingMode: 'monitoring' }
      })
    )
    recorder.onStatus(hook('working', T, { receivedAt: T + 300_000 }))
    recorder.onStatus(hook('done', T + 310_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(30_000)
  })

  it('dates the first live row after a restored one by the evidence, not the restored clock', () => {
    // A live repeat after hydration can retain an earlier runtime's working clock.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T - 3_600_000, { receivedAt: T }))
    recorder.onStatus(hook('done', T + 60_000))

    expect(stats.getSummary().totalAgentTimeMs).toBe(60_000)
  })
})

describe('AgentSessionTransitionRecorder fed by the status store', () => {
  it('dates a live start on a hydrated row by this runtime, not the persisted state clock', async () => {
    // OSC repeats lack main-agent evidence and retain persisted state-start time.
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
    first.flushStatusPersistSync()
    first.stop()

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
      server.stop()
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
