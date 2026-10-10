// Golden row writes for the Codex subagent roster: every append and publish it makes, and every
// admission it hands back, for scripted event sequences, so moving the roster onto shared code
// cannot change a saved byte.

import { describe, expect, it } from 'vitest'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import { recordingSubagentRowSink } from '../native-chat/subagent-row-sink-recorder-test-support'
import type { CodexThreadItem } from './codex-structured-item-translation'
import { CodexSubagentRoster } from './codex-subagent-roster'

const PARENT = 'thread-parent'

/** The clock moves once per delivered event, never per read, so a row's times do not depend on how
 *  often the roster happens to read it. */
function harness() {
  const recorder = recordingSubagentRowSink()
  let clock = 1_000
  let parentTurn: string | null = 'turn-1'
  const roster = new CodexSubagentRoster({
    sink: recorder.sink,
    primaryThreadId: () => PARENT,
    activeTurn: (threadId) => (threadId === PARENT ? parentTurn : null),
    turnScopeFor: (threadId, turnId): AgentJournalTurnScope =>
      turnId === null ? { kind: 'thread' } : { kind: 'turn', turnItemId: `${threadId}/${turnId}` },
    now: () => clock
  })
  const admissions: boolean[] = []
  const note = (admission: { accepted: boolean } | null) => {
    admissions.push(admission?.accepted ?? true)
  }
  const tick = <T>(deliver: () => T): T => {
    clock += 10
    return deliver()
  }
  const activity = (kind: string, child: string, path: string | null): CodexThreadItem => ({
    type: 'subAgentActivity',
    id: `item-${child}-${kind}`,
    kind,
    agentThreadId: child,
    agentPath: path
  })
  return {
    ...recorder,
    roster,
    admissions,
    parentTurn: (next: string | null) => {
      parentTurn = next
    },
    tick,
    announce: (kind: string, child: string, path: string | null) => {
      clock += 10
      note(
        roster.handleItem({
          threadId: PARENT,
          turnId: parentTurn,
          item: activity(kind, child, path)
        })
      )
    },
    turnStarted: (child: string, turnId: string) => {
      clock += 10
      note(roster.handleTurnEvent({ method: 'turn/started', threadId: child, params: { turnId } }))
    },
    turnCompleted: (child: string, turnId: string, status: string) => {
      clock += 10
      note(
        roster.handleTurnEvent({
          method: 'turn/completed',
          threadId: child,
          params: { turn: { id: turnId, status } }
        })
      )
    },
    tokens: (child: string, totalTokens: number) => {
      clock += 10
      note(roster.handleTokenUsage({ threadId: child, tokenUsage: { total: { totalTokens } } }))
    }
  }
}

describe('Codex subagent roster rows (characterization)', () => {
  it('one child: announced, runs a turn, reports tokens, completes', () => {
    const h = harness()
    h.announce('started', 'c1', '/root/reader')
    h.turnStarted('c1', 'ct1')
    h.announce('started', 'c1', '/root/reader')
    h.tokens('c1', 120)
    h.tokens('c1', 120)
    h.tokens('c1', 340)
    h.turnCompleted('c1', 'ct1', 'completed')
    h.tokens('c1', 400)
    expect({ log: h.log, admissions: h.admissions }).toMatchSnapshot()
  })

  it('two children sharing a path label, one failing and one interrupted', () => {
    const h = harness()
    h.turnStarted('c1', 'ct1')
    h.announce('started', 'c1', '/root/worker')
    h.turnStarted('c2', 'ct2')
    h.announce('started', 'c2', '/root/team/worker')
    h.turnStarted('c3', 'ct3')
    h.announce('started', 'c3', '/root/worker 2')
    h.turnCompleted('c1', 'ct1', 'failed')
    h.turnCompleted('c2', 'ct2', 'interrupted')
    h.turnCompleted('c3', 'ct3', 'mystery')
    expect(h.log).toMatchSnapshot()
  })

  it('a child given new work in a later parent turn, and a late end of its earlier run', () => {
    const h = harness()
    h.turnStarted('c1', 'ct1')
    h.announce('started', 'c1', '/root/reader')
    h.turnCompleted('c1', 'ct1', 'completed')
    h.parentTurn('turn-2')
    h.announce('interacted', 'c1', '/root/reader')
    h.turnStarted('c1', 'ct2')
    h.turnCompleted('c1', 'ct1', 'failed')
    h.turnStarted('c1', 'ct1')
    h.turnCompleted('c1', 'ct2', 'completed')
    expect(h.log).toMatchSnapshot()
  })

  it('a child running when the session ends, then a late verdict', () => {
    const h = harness()
    h.turnStarted('c1', 'ct1')
    h.announce('started', 'c1', '/root/a')
    h.turnStarted('c2', 'ct2')
    h.announce('started', 'c2', '/root/b')
    h.turnCompleted('c2', 'ct2', 'completed')
    note(h.tick(() => h.roster.settleSession()))
    h.turnCompleted('c1', 'ct1', 'completed')
    expect(h.log).toMatchSnapshot()

    function note(admission: { accepted: boolean }) {
      h.admissions.push(admission.accepted)
    }
  })

  it('a child thread closing mid-turn, then its turn completing', () => {
    const h = harness()
    h.turnStarted('c1', 'ct1')
    h.announce('started', 'c1', '/root/a')
    h.tick(() => h.roster.executions.closeThread('c1'))
    h.turnCompleted('c1', 'ct1', 'completed')
    expect(h.log).toMatchSnapshot()
  })

  it('a child announced outside any parent turn', () => {
    const h = harness()
    h.parentTurn(null)
    h.turnStarted('c1', 'ct1')
    h.announce('started', 'c1', '/root/loose')
    h.parentTurn('turn-5')
    h.turnCompleted('c1', 'ct1', 'completed')
    expect(h.log).toMatchSnapshot()
  })

  it('more than 32 settled groups, then a late frame for an evicted run', () => {
    const h = harness()
    for (let index = 0; index < 34; index++) {
      h.parentTurn(`turn-${index}`)
      h.turnStarted(`c${index}`, `ct${index}`)
      h.announce('started', `c${index}`, `/root/job${index}`)
      h.turnCompleted(`c${index}`, `ct${index}`, 'completed')
    }
    h.parentTurn('turn-live')
    h.turnStarted('live', 'ctl')
    h.announce('started', 'live', '/root/live')
    h.turnCompleted('c0', 'ct0', 'failed')
    h.turnStarted('c0', 'ct0')
    h.announce('started', 'c0', '/root/job0')
    expect(h.log.length).toMatchSnapshot()
    expect(h.log.slice(-6)).toMatchSnapshot()
    expect(h.roster.retentionSizes()).toMatchSnapshot()
  })

  it('a refused append or publish is handed back, and the redelivered frame writes it', () => {
    const h = harness()
    h.turnStarted('c1', 'ct1')
    h.refuseNextAppend()
    h.announce('started', 'c1', '/root/a')
    h.announce('started', 'c1', '/root/a')
    h.refuseNextPublish()
    h.turnCompleted('c1', 'ct1', 'completed')
    h.turnCompleted('c1', 'ct1', 'completed')
    h.tokens('c1', 50)
    expect({ log: h.log, admissions: h.admissions }).toMatchSnapshot()
  })
})
