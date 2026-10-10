import { describe, expect, it } from 'vitest'
import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import { SubagentTracker } from './subagent-tracker'
import type { JournaledSubagentSource, SubagentReport } from './subagent-tracker-types'

type Write = { groupId: string; agents: NativeChatSubagentEntry[] | null }

function harness(journaled?: JournaledSubagentSource<string>) {
  const writes: Write[] = []
  let refuse = false
  let clock = 100
  const tracker = new SubagentTracker<string>({
    port: {
      write: (group, { body }): StructuredAgentSessionSinkAdmission => {
        if (refuse) {
          return { accepted: false, reason: 'backpressure' }
        }
        const block = body?.blocks.find((candidate) => candidate.type === 'subagent-group')
        writes.push({
          groupId: group.groupId,
          agents: block?.type === 'subagent-group' ? block.agents : null
        })
        return { accepted: true }
      }
    },
    ...(journaled ? { journaled } : {}),
    outsideTurn: (groupId) => groupId.startsWith('outside'),
    now: () => clock
  })
  const report = (
    group: string,
    fields: Omit<SubagentReport<string>, 'group' | 'announces'> & { announces?: boolean }
  ) => {
    clock += 10
    return tracker.report({
      announces: true,
      ...fields,
      group: { id: group, placement: () => group }
    })
  }
  const row = (groupId: string) => writes.findLast((write) => write.groupId === groupId)?.agents
  return {
    tracker,
    writes,
    report,
    row,
    refuse: (value: boolean) => {
      refuse = value
    },
    tick: () => (clock += 10)
  }
}

describe('SubagentTracker', () => {
  it('lists only an announced child, in the group its report names', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', announces: false, state: 'completed' })
    expect(h.writes).toEqual([])
    h.report('turn-1', { id: 'a', label: 'Audit' })
    h.report('turn-2', { id: 'a', state: 'completed', announces: false })
    expect(h.row('turn-1')).toEqual([
      { id: 'a', label: 'Audit', state: 'completed', startedAt: 120, settledAt: 130 }
    ])
    expect(h.row('turn-2')).toBeUndefined()
  })

  it('numbers shared names over the labels already claimed, provider-named ones included', () => {
    const h = harness()
    for (const [id, label] of [
      ['a', 'Audit'],
      ['b', 'Audit 2'],
      ['c', 'Audit'],
      ['d', null]
    ] as const) {
      h.report('turn', { id, label })
    }
    expect(h.row('turn')?.map((entry) => entry.label)).toEqual([
      'Audit',
      'Audit 2',
      'Audit 3',
      'subagent'
    ])
    h.report('turn', { id: 'd', label: 'Named later', announces: false })
    expect(h.row('turn')?.at(-1)?.label).toBe('Named later')
  })

  it('latches proven outcomes but lets a verdict correct lost contact', () => {
    const h = harness()
    h.report('turn', { id: 'a' })
    h.report('turn', { id: 'b' })
    h.tracker.settleSession()
    expect(h.row('turn')?.map((entry) => entry.state)).toEqual(['unverifiable', 'unverifiable'])
    h.report('turn', { id: 'a', state: 'completed', announces: false })
    h.report('turn', { id: 'a', state: 'failed', announces: false })
    h.report('turn', { id: 'b', state: 'working', announces: false })
    expect(h.row('turn')).toEqual([
      expect.objectContaining({ id: 'a', state: 'completed', settledAt: 130 }),
      expect.objectContaining({ id: 'b', state: 'unverifiable' })
    ])
  })

  it('reopens a resumed child in the one row that lists it, and ignores its earlier runs', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit', tokens: 5 })
    h.report('turn-1', { id: 'a', run: 'r1', state: 'completed', announces: false })
    h.report('turn-2', { id: 'a', run: 'r2', label: 'Audit' })
    expect(h.row('turn-2')).toBeUndefined()
    expect(h.row('turn-1')).toEqual([
      { id: 'a', label: 'Audit', state: 'working', startedAt: 130, tokens: 5 }
    ])
    // A late verdict or a replayed announcement of the earlier run changes nothing.
    h.report('turn-2', { id: 'a', run: 'r1', state: 'failed', announces: false })
    h.report('turn-2', { id: 'a', run: 'r1' })
    expect(h.row('turn-1')).toEqual([expect.objectContaining({ state: 'working' })])
    expect(h.tracker.attempt('a')).toBe(2)
  })

  it('names a placeholder child when a later run is announced with a name', () => {
    const h = harness()
    h.report('turn', { id: 'a', run: 'r1' })
    h.report('turn', { id: 'a', run: 'r2', label: 'Audit' })
    expect(h.row('turn')).toEqual([expect.objectContaining({ label: 'Audit', state: 'working' })])
  })

  it('never releases the row no turn owns, so a later child cannot rewrite it from empty', () => {
    const h = harness()
    h.report('outside', { id: 'loose', state: 'completed' })
    for (let turn = 0; turn < 40; turn++) {
      h.report(`turn-${turn}`, { id: `c${turn}`, state: 'completed' })
    }
    h.report('outside', { id: 'later' })
    expect(h.row('outside')?.map((entry) => entry.id)).toEqual(['loose', 'later'])
  })

  it('reopens a run started again in the same turn, and never applies an old run to it', () => {
    const h = harness()
    h.report('turn', { id: 'a', run: 'r1' })
    h.report('turn', { id: 'a', run: 'r1', state: 'completed', announces: false })
    h.report('turn', { id: 'a', run: 'r2' })
    h.report('turn', { id: 'a', run: 'r1', state: 'failed', announces: false })
    expect(h.row('turn')).toEqual([
      { id: 'a', label: 'subagent', state: 'working', startedAt: 130 }
    ])
  })

  it('remembers runs aged out of a busy child, so none is revived', () => {
    const h = harness()
    for (let run = 0; run < 20; run++) {
      h.report('turn', { id: 'a', run: `r${run}` })
      h.report('turn', { id: 'a', run: `r${run}`, state: 'completed', announces: false })
    }
    h.report('turn', { id: 'a', run: 'r0' })
    expect(h.row('turn')).toEqual([expect.objectContaining({ state: 'completed' })])
    expect(h.tracker.attempt('a')).toBe(20)
  })

  it('ends a foreground run with the turn that started it, wherever its child is listed', () => {
    const h = harness()
    h.report('turn-1', { id: 'x', run: 'r1' })
    h.report('turn-1', { id: 'x', run: 'r1', state: 'completed', announces: false })
    h.report('turn-5', { id: 'x', run: 'r2' })
    h.tracker.settleTurn('turn-1')
    expect(h.row('turn-1')).toEqual([expect.objectContaining({ state: 'working' })])
    h.tracker.settleTurn('turn-5')
    expect(h.row('turn-1')).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  })

  it('keeps an inherited no-turn row first reached through one of its children', () => {
    let claimed = false
    const h = harness({
      groupOf: (id) => (id === 'a' ? 'outside-turn' : null),
      claimGroup: (groupId) => {
        if (groupId !== 'outside-turn' || claimed) {
          return null
        }
        claimed = true
        return {
          entries: [{ id: 'a', label: 'One', state: 'completed', startedAt: 1, settledAt: 2 }],
          placement: 'outside-turn'
        }
      }
    })
    h.report('outside-turn', { id: 'a', tokens: 3, announces: false })
    for (let turn = 0; turn < 40; turn++) {
      h.report(`turn-${turn}`, { id: `c${turn}`, state: 'completed' })
    }
    h.report('outside-turn', { id: 'b' })
    expect(h.row('outside-turn')?.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('ends only foreground children with their turn, and every child with the session', () => {
    const h = harness()
    h.report('turn', { id: 'fg' })
    h.report('turn', { id: 'bg', backgrounded: true })
    h.tracker.settleTurn('turn')
    expect(h.row('turn')?.map((entry) => entry.state)).toEqual(['unverifiable', 'working'])
    h.tracker.dispose()
    expect(h.row('turn')?.map((entry) => entry.state)).toEqual(['unverifiable', 'unverifiable'])
  })

  it('writes a refused revision again on the next write, and hands the refusal back', () => {
    const h = harness()
    h.refuse(true)
    expect(h.report('turn', { id: 'a' }).accepted).toBe(false)
    expect(h.report('turn', { id: 'a' }).accepted).toBe(false)
    h.refuse(false)
    h.report('turn', { id: 'a' })
    expect(h.writes).toHaveLength(1)
    h.report('turn', { id: 'a' })
    expect(h.writes).toHaveLength(1)
  })

  it('tries every group at session end before handing back the first refusal', () => {
    const h = harness()
    h.report('one', { id: 'a' })
    h.report('two', { id: 'b' })
    h.refuse(true)
    expect(h.tracker.settleSession().accepted).toBe(false)
    h.refuse(false)
    expect(h.tracker.settleSession().accepted).toBe(true)
    expect([h.row('one'), h.row('two')]).toEqual([
      [expect.objectContaining({ state: 'unverifiable' })],
      [expect.objectContaining({ state: 'unverifiable' })]
    ])
  })

  it('writes each group a batch changed once', () => {
    const h = harness()
    h.tracker.batch(() => {
      h.report('turn', { id: 'a' })
      h.report('turn', { id: 'b' })
      h.report('turn', { id: 'a', tokens: 0, announces: false })
    })
    expect(h.writes).toEqual([
      {
        groupId: 'turn',
        agents: [
          expect.objectContaining({ id: 'a', tokens: 0 }),
          expect.objectContaining({ id: 'b' })
        ]
      }
    ])
  })

  it('removes a child that turned out not to be one, and the row with its last child', () => {
    const h = harness()
    h.report('turn', { id: 'a', label: 'Audit' })
    h.tracker.remove('a')
    expect(h.writes.at(-1)).toEqual({ groupId: 'turn', agents: null })
    h.report('turn', { id: 'b', label: 'Audit' })
    // A removed child's name stays claimed.
    expect(h.row('turn')).toEqual([expect.objectContaining({ label: 'Audit 2' })])
  })

  it('continues the row an earlier provider run journaled instead of rewriting it from empty', () => {
    let claimed = false
    const earlier: NativeChatSubagentEntry[] = [
      { id: 'a', label: 'One', state: 'completed', startedAt: 1, settledAt: 2 },
      { id: 'b', label: 'Two', state: 'unverifiable', startedAt: 1 }
    ]
    const h = harness({
      groupOf: (id) => (id === 'a' || id === 'b' ? 'outside-turn' : null),
      claimGroup: (groupId) => {
        if (groupId !== 'outside-turn' || claimed) {
          return null
        }
        claimed = true
        return { entries: earlier, placement: 'outside-turn' }
      },
      attempt: (id) => (id === 'b' ? 3 : 1)
    })
    h.report('outside-turn', { id: 'c', label: 'Three' })
    expect(h.row('outside-turn')?.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    // A verdict on a run the earlier process left says how it ended, not when.
    h.report('outside-turn', { id: 'b', run: 'old-call', state: 'stopped', announces: false })
    expect(h.row('outside-turn')?.[1]).toEqual({
      id: 'b',
      label: 'Two',
      state: 'stopped',
      startedAt: 1
    })
    h.report('turn-9', { id: 'b', run: 'resume' })
    expect(h.tracker.attempt('b')).toBe(4)
    expect(h.row('turn-9')).toBeUndefined()
    expect(h.row('outside-turn')?.[1]).toEqual(
      expect.objectContaining({ id: 'b', label: 'Two', state: 'working' })
    )
  })
})
