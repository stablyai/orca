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

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

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
    payload: { state },
    ...extra
  }
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

describe('classifyAgentSessionTransition', () => {
  it('treats an unchanged state as a snapshot, never a transition', () => {
    expect(
      classifyAgentSessionTransition({ state: 'working', open: true }, hook('working', T))
    ).toBe('none')
    expect(classifyAgentSessionTransition({ state: 'done', open: false }, hook('done', T))).toBe(
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
    expect(classifyAgentSessionTransition({ state: 'working', open: true }, hook('done', T))).toBe(
      'stop'
    )
    expect(classifyAgentSessionTransition({ state: 'working', open: false }, hook('done', T))).toBe(
      'none'
    )
  })
})
