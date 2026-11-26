import { describe, expect, it } from 'vitest'
import type { ThreadStatusFact } from '../../../shared/connectors/external-conversation-link'
import {
  decideThreadStatus,
  mayArm,
  threadStatusElapsed,
  THREAD_STATUS_STOP_LINE,
  utcDay,
  type ThreadStatusInput,
  type ThreadStatusView
} from './thread-status-decide'

const MIN = 60_000
const HOUR = 60 * MIN
const START = Date.UTC(2026, 10, 26, 2, 9)

const working: ThreadStatusView = { activity: 'working', open: true, helpersRunning: false }

function armedAt(at: number, extra: Partial<NonNullable<ThreadStatusFact['armed']>> = {}) {
  return {
    seq: 0,
    day: utcDay(at),
    dayCount: 0,
    armed: { at, turnEndAt: at, lastLineAt: at, lastBotAt: 0, dueStep: 0 as const, ...extra }
  }
}

function decide(input: Partial<ThreadStatusInput> & { now: number }) {
  return decideThreadStatus({
    eligible: true,
    fact: armedAt(START),
    view: working,
    held: false,
    ...input
  })
}

describe('decideThreadStatus', () => {
  it('waits until 30 quiet minutes, then says it is still working', () => {
    expect(decide({ now: START + 30 * MIN - 1 })).toEqual({ kind: 'wait' })
    expect(decide({ now: START + 30 * MIN })).toEqual({
      kind: 'post',
      text: 'Still working on this (30 min).',
      stop: false
    })
  })

  it('posts 4 heartbeats and then the stop line in 6 unchanged hours', () => {
    let fact: ThreadStatusFact = armedAt(START)
    const posted: string[] = []
    for (let now = START; now <= START + 7 * HOUR; now += MIN) {
      const decided = decide({ now, fact })
      if (decided.kind === 'disarm') {
        break
      }
      if (decided.kind !== 'post') {
        continue
      }
      posted.push(`${(now - START) / MIN}: ${decided.text}`)
      if (decided.stop) {
        break
      }
      const armed = fact.armed!
      fact = {
        ...fact,
        dayCount: fact.dayCount + 1,
        armed: {
          ...armed,
          lastLineAt: now,
          dueStep: Math.min(armed.dueStep + 1, 2) as 0 | 1 | 2,
          lines: (armed.lines ?? 0) + 1
        }
      }
    }
    expect(posted).toEqual([
      '30: Still working on this (30 min).',
      '90: Still working on this (1 h 30 min).',
      '210: Still working on this (3 h 30 min).',
      '330: Still working on this (5 h 30 min).',
      `360: ${THREAD_STATUS_STOP_LINE}`
    ])
  })

  it('times the next line by the backoff step, and a bot line restarts it', () => {
    const afterOne = armedAt(START, { lastLineAt: START + 30 * MIN, dueStep: 1 })
    expect(decide({ now: START + 89 * MIN, fact: afterOne }).kind).toBe('wait')
    expect(decide({ now: START + 90 * MIN, fact: afterOne }).kind).toBe('post')
    const botSpoke = armedAt(START, { lastLineAt: START + 60 * MIN, dueStep: 0 })
    expect(decide({ now: START + 90 * MIN, fact: botSpoke }).kind).toBe('post')
  })

  it('never says working for an idle worker with nothing under it', () => {
    const decided = decide({
      now: START + 30 * MIN,
      view: { activity: 'idle', open: true, helpersRunning: false }
    })
    expect(decided).toEqual({
      kind: 'post',
      text: 'Still open (30 min), but nothing is running on it right now. Reply here to ask where it stands.',
      stop: false
    })
  })

  it('says working for an idle worker whose helpers run, and for lost contact', () => {
    for (const view of [
      { activity: 'idle', open: true, helpersRunning: true },
      { activity: 'unverifiable', open: true, helpersRunning: false }
    ] as const) {
      expect(decide({ now: START + 30 * MIN, view })).toMatchObject({
        text: 'Still working on this (30 min).'
      })
    }
  })

  it('stops quietly when the work settles or the thread may no longer hear it', () => {
    const now = START + 30 * MIN
    expect(decide({ now, view: { ...working, activity: 'none', open: false } })).toEqual({
      kind: 'disarm'
    })
    expect(decide({ now, eligible: false })).toEqual({ kind: 'disarm' })
  })

  it('waits while the workers are unread or something else is on its way to the thread', () => {
    expect(decide({ now: START + 30 * MIN, view: undefined })).toEqual({ kind: 'wait' })
    expect(decide({ now: START + 30 * MIN, held: true })).toEqual({ kind: 'wait' })
    expect(decide({ now: START + 30 * MIN, fact: undefined })).toEqual({ kind: 'wait' })
  })

  it('posts the stop line when the workers read closes, 6 hours pass or the day is full', () => {
    const stop = { kind: 'post', text: THREAD_STATUS_STOP_LINE, stop: true }
    const posted = armedAt(START, { lines: 1 })
    // Closed by the workers' own 6 h or 15 min unverifiable bound.
    expect(
      decide({
        now: START + 40 * MIN,
        fact: posted,
        view: { activity: 'idle', open: false, helpersRunning: false }
      })
    ).toEqual(stop)
    expect(
      decide({
        now: START + 6 * HOUR,
        fact: { ...posted, armed: { ...posted.armed, lastLineAt: START + 6 * HOUR } }
      })
    ).toEqual(stop)
    // The 12th line of the day is the stop line.
    expect(decide({ now: START + 5 * MIN, fact: { ...posted, dayCount: 11 } })).toEqual(stop)
    // Yesterday's lines don't count today.
    expect(
      decide({ now: START + 5 * MIN, fact: { ...posted, day: '2026-11-25', dayCount: 11 } })
    ).toEqual({ kind: 'wait' })
    expect(decide({ now: START + 6 * HOUR, fact: posted, held: true })).toEqual({ kind: 'wait' })
  })

  it('ends a run quietly when it posted no update, or could not stop for 30 minutes past its end', () => {
    const closed = { activity: 'idle', open: false, helpersRunning: false } as const
    expect(decide({ now: START + 15 * MIN, view: closed })).toEqual({ kind: 'disarm' })
    expect(decide({ now: START + 6 * HOUR })).toEqual({ kind: 'disarm' })
    const posted = armedAt(START, { lines: 2 })
    expect(decide({ now: START + 6 * HOUR + 30 * MIN, fact: posted, view: undefined })).toEqual({
      kind: 'disarm'
    })
    expect(decide({ now: START + 6 * HOUR + 30 * MIN, fact: posted, held: true })).toEqual({
      kind: 'disarm'
    })
  })

  it('arms only while the day leaves room for an update and its stop line', () => {
    expect(mayArm(undefined, START)).toBe(true)
    expect(mayArm({ seq: 10, day: utcDay(START), dayCount: 10 }, START)).toBe(true)
    expect(mayArm({ seq: 11, day: utcDay(START), dayCount: 11 }, START)).toBe(false)
    expect(mayArm({ seq: 11, day: '2026-11-25', dayCount: 11 }, START)).toBe(true)
  })

  it('keeps every line short and built only from its fixed words', () => {
    const texts = [
      decide({ now: START + 30 * MIN }),
      decide({
        now: START + 23 * HOUR + 59 * MIN,
        fact: armedAt(START, { turnEndAt: START + 20 * HOUR, lastLineAt: START + 20 * HOUR })
      }),
      decide({
        now: START + 30 * MIN,
        view: { activity: 'idle', open: true, helpersRunning: false }
      }),
      decide({ now: START + 6 * HOUR, fact: armedAt(START, { lines: 1 }) })
    ].map((decided) => (decided.kind === 'post' ? decided.text : ''))
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0)
      expect(text.length).toBeLessThanOrEqual(140)
      expect(text).not.toMatch(/[@<>/]/)
    }
  })
})

describe('threadStatusElapsed', () => {
  it('reads as minutes, then hours and minutes', () => {
    expect(threadStatusElapsed(35 * MIN + 59_000)).toBe('35 min')
    expect(threadStatusElapsed(90 * MIN)).toBe('1 h 30 min')
    expect(threadStatusElapsed(5 * HOUR)).toBe('5 h')
  })
})
