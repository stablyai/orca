import { describe, expect, it } from 'vitest'
import type { VoiceRosterEntry } from './voice-control-roster'
import {
  computeWatchdogFindings,
  watchdogFindingKey,
  type OutstandingWorkItem
} from './voice-control-watchdog'

function outstanding(overrides: Partial<OutstandingWorkItem> = {}): OutstandingWorkItem {
  return {
    paneKey: 'tab-1:leaf',
    spokenName: 'oak',
    task: 'run the tests',
    dispatchedAt: 1,
    ...overrides
  }
}

function rosterEntry(
  state: string,
  paneKey = 'tab-1:leaf',
  stateStartedAt?: number
): VoiceRosterEntry {
  return {
    spokenName: 'oak',
    worktreeId: 'w1',
    repoId: 'r1',
    paneKey,
    agentType: 'claude',
    state,
    stateStartedAt,
    taskTitle: 'Fixing login',
    toolName: null,
    worktreePath: '/tmp/x',
    hostId: null
  }
}

describe('computeWatchdogFindings', () => {
  it('reports a done agent as a done finding with its task', () => {
    const findings = computeWatchdogFindings({
      outstanding: [outstanding()],
      roster: [rosterEntry('done')],
      notified: new Set()
    })
    expect(findings).toEqual([
      {
        paneKey: 'tab-1:leaf',
        spokenName: 'oak',
        kind: 'done',
        detail: 'oak reports done (task: run the tests).'
      }
    ])
  })

  it('reports waiting and blocked agents as needing the user', () => {
    for (const state of ['waiting', 'blocked']) {
      const findings = computeWatchdogFindings({
        outstanding: [outstanding()],
        roster: [rosterEntry(state)],
        notified: new Set()
      })
      expect(findings).toHaveLength(1)
      expect(findings[0]?.kind).toBe('needs-user')
      expect(findings[0]?.detail).toContain(`oak is ${state}`)
    }
  })

  it('finds nothing while the agent is still working', () => {
    const findings = computeWatchdogFindings({
      outstanding: [outstanding()],
      roster: [rosterEntry('working')],
      notified: new Set()
    })
    expect(findings).toEqual([])
  })

  // Live failure this guards: a worker that never woke kept its PREVIOUS session's
  // 'done', and the watchdog announced the new task as finished 20s after dispatch.
  it('ignores a state that began before the dispatch — last task’s news is not this one’s', () => {
    const findings = computeWatchdogFindings({
      outstanding: [outstanding({ dispatchedAt: 1_000_000 })],
      roster: [rosterEntry('done', 'tab-1:leaf', 100_000)],
      notified: new Set()
    })
    expect(findings).toEqual([])
  })

  it('a state begun within the grace window still counts (cross-host clock skew)', () => {
    const findings = computeWatchdogFindings({
      outstanding: [outstanding({ dispatchedAt: 1_000_000 })],
      roster: [rosterEntry('done', 'tab-1:leaf', 1_000_000 - 89_999)],
      notified: new Set()
    })
    expect(findings).toHaveLength(1)
  })

  it('skips a pane that left the roster entirely', () => {
    const findings = computeWatchdogFindings({
      outstanding: [outstanding()],
      roster: [],
      notified: new Set()
    })
    expect(findings).toEqual([])
  })

  it('never re-fires an already-notified finding', () => {
    const notified = new Set(['tab-1:leaf:done'])
    const findings = computeWatchdogFindings({
      outstanding: [outstanding()],
      roster: [rosterEntry('done')],
      notified
    })
    expect(findings).toEqual([])
  })

  it('a state change after a done announcement can still surface a new kind', () => {
    // The notified set is per pane+kind, so a later 'waiting' on the same pane fires.
    const notified = new Set(['tab-1:leaf:done'])
    const findings = computeWatchdogFindings({
      outstanding: [outstanding()],
      roster: [rosterEntry('waiting')],
      notified
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('needs-user')
  })

  it('keys findings by pane and kind', () => {
    expect(
      watchdogFindingKey({
        paneKey: 'p1',
        spokenName: 'oak',
        kind: 'needs-user',
        detail: 'x'
      })
    ).toBe('p1:needs-user')
  })
})
