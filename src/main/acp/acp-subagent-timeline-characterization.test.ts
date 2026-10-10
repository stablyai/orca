// Golden timeline events from the ACP subagent roster for scripted update sequences, so moving it
// onto shared code cannot change a saved byte.

import { describe, expect, it } from 'vitest'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'
import { AcpSubagentTimeline } from './acp-subagent-timeline'
import type { AcpTimelineEvent } from './acp-timeline-event'

function harness() {
  const timeline = new AcpSubagentTimeline()
  const log: AcpTimelineEvent[][] = []
  let at = 1_000
  return {
    timeline,
    log,
    send: (updates: AcpSubagentUpdate[], join: { thread?: string; turn?: string }) => {
      log.push(timeline.translate(updates, join, (at += 10)))
    }
  }
}

const JOIN = { thread: 'parent', turn: 'turn-1' }

describe('ACP subagent timeline rows (characterization)', () => {
  it('one child: working, tokens, completed with its reply, replayed', () => {
    const h = harness()
    h.send([{ id: 'a1', label: 'Explore', state: 'working' }], JOIN)
    h.send([{ id: 'a1', tokens: 0 }], JOIN)
    h.send([{ id: 'a1', tokens: 200 }], JOIN)
    h.send([{ id: 'a1', state: 'completed', result: 'Found it' }], JOIN)
    h.send([{ id: 'a1', state: 'completed', result: 'Found it' }], JOIN)
    h.send([{ id: 'a1', state: 'failed' }], JOIN)
    expect(h.log).toMatchSnapshot()
  })

  it('children sharing a label, a provider-named ordinal, and outcomes in one batch', () => {
    const h = harness()
    h.send(
      [
        { id: 'a1', label: 'Audit' },
        { id: 'a2', label: 'Audit' },
        { id: 'a3', label: 'Audit 2' },
        { id: 'a4' }
      ],
      JOIN
    )
    h.send(
      [
        { id: 'a1', state: 'stopped' },
        { id: 'a2', state: 'unverifiable' },
        { id: 'a2', state: 'completed', result: 'late' },
        { id: 'a3', state: 'failed' }
      ],
      JOIN
    )
    expect(h.log).toMatchSnapshot()
  })

  it('knownOnly updates, turn from the update, and the no-turn group', () => {
    const h = harness()
    h.send([{ id: 'unknown', state: 'completed', knownOnly: true }], JOIN)
    h.send([{ id: 'a1', label: 'Spawned', turn: 'turn-0' }], JOIN)
    h.send([{ id: 'a2', label: 'Loose' }], { thread: 'parent' })
    h.send([{ id: 'a1', state: 'stopped', knownOnly: true }], JOIN)
    expect({
      log: h.log,
      has: ['unknown', 'a1', 'a2'].map((id) => h.timeline.has(id))
    }).toMatchSnapshot()
  })

  it('a group past 64 children drops the rest', () => {
    const h = harness()
    h.send(
      Array.from({ length: 66 }, (_, index): AcpSubagentUpdate => ({
        id: `c${index}`,
        label: 'X'
      })),
      JOIN
    )
    const last = h.log.at(-1)?.at(-1)
    expect({
      events: h.log.at(-1)?.length,
      lastLabels:
        last && 'body' in last && last.body.kind === 'message'
          ? JSON.stringify(last.body.blocks).slice(-300)
          : null,
      has: [h.timeline.has('c63'), h.timeline.has('c64')]
    }).toMatchSnapshot()
  })

  it('more than 32 settled groups, then a late update for an evicted child', () => {
    const h = harness()
    for (let index = 0; index < 34; index++) {
      h.send([{ id: `c${index}`, label: `Job ${index}`, state: 'completed' }], {
        thread: 'parent',
        turn: `turn-${index}`
      })
    }
    h.send([{ id: 'live', label: 'Live' }], { thread: 'parent', turn: 'turn-live' })
    h.send([{ id: 'c0', state: 'failed' }], JOIN)
    h.send([{ id: 'c0', label: 'Job 0' }], JOIN)
    expect({
      tail: h.log.slice(-3),
      has: [h.timeline.has('c0'), h.timeline.has('c1'), h.timeline.has('c33')]
    }).toMatchSnapshot()
  })

  it('writes nothing after dispose', () => {
    const h = harness()
    h.send([{ id: 'a1', label: 'A' }], JOIN)
    h.timeline.dispose()
    h.send([{ id: 'a1', state: 'completed' }], JOIN)
    expect({ log: h.log, has: h.timeline.has('a1') }).toMatchSnapshot()
  })
})
