import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOOK_AROUND_DEFAULTS, patchLookAround } from '../../shared/bots/bot-look-around'
import {
  beginRun,
  endRun,
  EMPTY_BOT_LOOK,
  type BotLookState,
  type LookSlot
} from './bot-look-around-state'
import { lookAroundDecision, lookAroundDueAt } from './bot-look-around-schedule'
import { lookAroundNeedsYou, lookAroundScheduleState } from './bot-look-around-status'

// Local times, as the host reads its hours: Monday 2026-10-26.
const at = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 9, day, hour, minute, second).getTime()
const armed = (time: number): BotLookState => ({ ...EMPTY_BOT_LOOK, armedAt: time })
const setting = LOOK_AROUND_DEFAULTS
const custom = (times: string[], more = {}) => ({
  ...setting,
  every: 'custom' as const,
  times,
  ...more
})
const looked = (state: BotLookState, id: string, startedAt: number, slot?: LookSlot) =>
  endRun(beginRun(state, id, startedAt, slot), id, startedAt + 60_000)
const next = (s: typeof setting, state: BotLookState, now: number) =>
  lookAroundDecision(s, state, now).next

describe('Look around hours', () => {
  it('waits one interval after the first conversation, then takes the next slot', () => {
    const state = armed(at(26, 9, 30))
    expect(lookAroundDueAt(setting, state, at(26, 12, 1))).toBeNull()
    expect(next(setting, state, at(26, 12, 1))).toEqual({ at: at(26, 16) })
    expect(lookAroundDueAt(setting, state, at(26, 16, 1))).toBe(at(26, 16))
  })

  it('looks nowhere before the first conversation', () => {
    expect(lookAroundDecision(setting, EMPTY_BOT_LOOK, at(26, 16, 1))).toEqual({ due: null })
  })

  it('takes each slot once, and catches a missed one up the same day, never the next', () => {
    const state = armed(at(20, 9))
    const done = looked(state, 'run-1', at(26, 16, 1), { scheduledFor: at(26, 16) })
    expect(lookAroundDueAt(setting, done, at(26, 16, 30))).toBeNull()
    // The host slept through 16:00 and woke at 17:30: caught up until 20:00.
    expect(lookAroundDueAt(setting, state, at(26, 17, 30))).toBe(at(26, 16))
    expect(next(setting, state, at(26, 17, 30))).toEqual({
      at: at(26, 16),
      due: true,
      until: at(26, 20)
    })
    // Asleep from before 20:00 until the next morning: yesterday's slot is not caught up.
    expect(lookAroundDueAt(setting, state, at(27, 7, 30))).toBeNull()
  })

  it("never gives up a slot the host's sleep keeps cutting short, spacing the tries", () => {
    let state = armed(at(20, 9))
    const slot = { scheduledFor: at(26, 16) }
    // Four looks cut short, each a quarter hour after the last ended: the slot stays owed.
    for (const [index, minute] of [1, 25, 50, 75].entries()) {
      expect(lookAroundDueAt(setting, state, at(26, 16, minute))).toBe(at(26, 16))
      state = endRun(
        beginRun(state, `run-${index}`, at(26, 16, minute), slot),
        `run-${index}`,
        at(26, 16, minute + 5),
        'missed',
        false,
        true
      )
      // Right after one, it waits.
      expect(lookAroundDueAt(setting, state, at(26, 16, minute + 10))).toBeNull()
    }
    expect(lookAroundDueAt(setting, state, at(26, 17, 40))).toBe(at(26, 16))
    // Up next reads it as owed even while it waits out a retry.
    expect(next(setting, state, at(26, 17, 25))).toMatchObject({ at: at(26, 16), due: true })
  })

  it('holds looks until a usage limit that ended the last one resets, then catches the slot up', () => {
    const state = armed(at(20, 9))
    const limited = endRun(
      beginRun(state, 'run-1', at(26, 12, 1)),
      'run-1',
      at(26, 12, 2),
      'unfinished',
      true,
      false,
      { resetsAt: at(26, 17) }
    )
    expect(lookAroundDueAt(setting, limited, at(26, 16, 1))).toBeNull()
    expect(next(setting, limited, at(26, 16, 1))?.at).toBe(at(26, 17))
    expect(lookAroundDueAt(setting, limited, at(26, 17, 1))).toBe(at(26, 16))
  })

  it('retries the slot a usage limit cut short once it resets, or after an hour when its reset is unknown', () => {
    const state = armed(at(20, 9))
    const limitedAt = (resetsAt?: number) =>
      endRun(
        beginRun(state, 'run-16', at(26, 16, 1)),
        'run-16',
        at(26, 16, 2),
        'unfinished',
        true,
        false,
        resetsAt === undefined ? {} : { resetsAt }
      )
    const known = limitedAt(at(26, 16, 30))
    expect(lookAroundDueAt(setting, known, at(26, 16, 20))).toBeNull()
    expect(lookAroundDueAt(setting, known, at(26, 16, 31))).toBe(at(26, 16))
    const unknown = limitedAt()
    expect(lookAroundDueAt(setting, unknown, at(26, 16, 50))).toBeNull()
    expect(lookAroundDueAt(setting, unknown, at(26, 17, 3))).toBe(at(26, 16))
  })

  it('names the retry after a usage limit as Next look when the reset comes before the retry spacing', () => {
    const limited = endRun(
      beginRun(armed(at(20, 9)), 'run-16', at(26, 16, 1)),
      'run-16',
      at(26, 16, 2),
      'unfinished',
      true,
      false,
      { resetsAt: at(26, 16, 5) }
    )
    expect(next(setting, limited, at(26, 16, 3))?.at).toBe(at(26, 16, 17))
    // Still the retry once the reset has passed.
    expect(next(setting, limited, at(26, 16, 6))?.at).toBe(at(26, 16, 17))
  })

  it('names the next slot as Next look when it comes before the retry of an owed one', () => {
    const limited = endRun(
      beginRun(armed(at(20, 9)), 'run-16', at(26, 19, 50)),
      'run-16',
      at(26, 19, 56),
      'unfinished',
      true,
      false,
      { resetsAt: at(26, 19, 58) }
    )
    expect(next(setting, limited, at(26, 19, 57))?.at).toBe(at(26, 20))
  })

  it('keeps a usage limit hold when a later look fails to start', () => {
    const limited = endRun(
      beginRun(armed(at(20, 9)), 'run-12', at(26, 12, 1)),
      'run-12',
      at(26, 12, 2),
      'unfinished',
      true,
      false,
      { resetsAt: at(26, 19) }
    )
    const failedStart = endRun(
      beginRun(limited, 'now-1', at(26, 14)),
      'now-1',
      at(26, 14),
      'no start'
    )
    expect(lookAroundDueAt(setting, failedStart, at(26, 16, 1))).toBeNull()
    expect(lookAroundDueAt(setting, failedStart, at(26, 19, 1))).toBe(at(26, 16))
  })

  it('never catches up a slot from before Look around was turned back on', () => {
    const state = armed(at(20, 9))
    const back = { ...setting, since: at(26, 13) }
    expect(lookAroundDueAt(back, state, at(26, 13, 1))).toBeNull()
    expect(lookAroundDueAt(back, state, at(26, 16, 1))).toBe(at(26, 16))
  })

  it('lets a Look now while a slot is caught up stand in for it, but a late look only its own', () => {
    // A Look now 2 hours after 8:00 stands in for it: its catch-up runs until 12:00.
    const state = looked(armed(at(20, 9)), 'now-1', at(26, 10))
    expect(lookAroundDueAt(setting, state, at(26, 10, 30))).toBeNull()
    expect(lookAroundDecision(setting, state, at(26, 12, 30)).missedAt).not.toBe(at(26, 8))
    // 8:00 caught up at 11:40 is 8:00's look: 12:00 still runs.
    const late = looked(armed(at(20, 9)), 'run-1', at(26, 11, 40), { scheduledFor: at(26, 8) })
    expect(lookAroundDueAt(setting, late, at(26, 12, 1))).toBe(at(26, 12))
  })

  it('says Next look is the due slot until it starts', () => {
    const state = armed(at(20, 9))
    expect(next(setting, state, at(26, 12, 0, 30))).toEqual({
      at: at(26, 12),
      due: true,
      until: at(26, 16)
    })
    expect(
      lookAroundScheduleState(setting, state, at(26, 12, 0, 30), { settled: false })
    ).toMatchObject({
      nextAt: at(26, 12),
      dueNow: true,
      nextHeld: true,
      nextGraceEndsAt: at(26, 16)
    })
    // A paused bot has no look due.
    expect(
      lookAroundScheduleState(setting, state, at(26, 12, 0, 30), { paused: true })
    ).not.toHaveProperty('dueNow')
    const started = beginRun(state, 'run-1', at(26, 12, 1), { scheduledFor: at(26, 12) })
    expect(next(setting, started, at(26, 12, 1))).toEqual({ at: at(26, 16) })
  })

  it('lets a Look now just before a slot stand in for it, and Next look says why', () => {
    // 8:00 ran, so nothing is overdue and the Look now stands in for 12:00.
    const ran = looked(armed(at(20, 9)), 'run-0', at(26, 8), { scheduledFor: at(26, 8) })
    const lookedNow = looked(ran, 'run-1', at(26, 11, 30))
    expect(lookAroundDueAt(setting, lookedNow, at(26, 12, 1))).toBeNull()
    expect(next(setting, lookedNow, at(26, 11, 45))).toEqual({
      at: at(26, 16),
      skipped: { at: at(26, 12), lookedAt: at(26, 11, 30) }
    })
    expect(lookAroundDueAt(setting, lookedNow, at(26, 16, 1))).toBe(at(26, 16))
  })

  it('skips weekends unless set to every day', () => {
    const state = armed(at(20, 9))
    // Saturday 2026-10-31.
    expect(lookAroundDueAt(setting, state, at(31, 12, 1))).toBeNull()
    expect(lookAroundDueAt({ ...setting, weekdaysOnly: false }, state, at(31, 12, 1))).toBe(
      at(31, 12)
    )
  })
})

describe('Custom times', () => {
  it('looks at each of its own times, minutes included', () => {
    const times = custom(['09:30', '14:00', '17:45'])
    const state = armed(at(20, 9))
    expect(lookAroundDueAt(times, state, at(26, 9, 31))).toBe(at(26, 9, 30))
    expect(lookAroundDueAt(times, state, at(26, 14, 1))).toBe(at(26, 14))
    // 2:00 PM with no look is caught up until 5:45 PM, and 5:45 PM until the day ends.
    expect(next(times, state, at(26, 15, 30))).toEqual({
      at: at(26, 14),
      due: true,
      until: at(26, 17, 45)
    })
    expect(next(times, state, at(26, 19))).toEqual({
      at: at(26, 17, 45),
      due: true,
      until: at(27, 0)
    })
    const done = looked(state, 'run-1', at(26, 17, 46), { scheduledFor: at(26, 17, 45) })
    expect(next(times, done, at(26, 19))).toEqual({ at: at(27, 9, 30) })
  })

  it('keeps the next slot an hour later when the scheduled look before it started late', () => {
    const times = custom(['09:30', '10:30'])
    // The 9:30 look started a few seconds late, as a minute tick does.
    const late = looked(armed(at(20, 9)), 'run-1', at(26, 9, 30, 5), {
      scheduledFor: at(26, 9, 30)
    })
    expect(next(times, late, at(26, 9, 45))).toEqual({ at: at(26, 10, 30) })
    expect(lookAroundDueAt(times, late, at(26, 10, 30, 2))).toBe(at(26, 10, 30))
    // Taken once: the tick after it started finds nothing due.
    const second = beginRun(late, 'run-2', at(26, 10, 30, 2), { scheduledFor: at(26, 10, 30) })
    expect(lookAroundDueAt(times, second, at(26, 10, 31))).toBeNull()
    // A Look now at 10:00 still stands in for 10:30.
    const lookedNow = looked(late, 'now-1', at(26, 10))
    expect(lookAroundDueAt(times, lookedNow, at(26, 10, 30, 2))).toBeNull()
  })

  it('wraps a weekdays-only schedule from Friday to Monday', () => {
    const times = custom(['09:30', '14:00'])
    // Friday 2026-10-30, after its last time ran.
    const ran = looked(armed(at(20, 9)), 'run-1', at(30, 14), { scheduledFor: at(30, 14) })
    expect(next(times, ran, at(30, 16))).toEqual({
      at: new Date(2026, 10, 2, 9, 30).getTime()
    })
  })

  it('takes a switch from a preset to Custom on the next slot, and back keeps the times', () => {
    const state = looked(armed(at(20, 9)), 'run-1', at(26, 8), { scheduledFor: at(26, 8) })
    expect(next(setting, state, at(26, 10))).toEqual({ at: at(26, 12) })
    const switched = patchLookAround(setting, { times: ['10:30', '15:00'] }, 0)
    expect(switched.every).toBe('custom')
    expect(next(switched, state, at(26, 10))).toEqual({ at: at(26, 10, 30) })
    const back = patchLookAround(switched, { every: 'every-4h' }, 0)
    expect(next(back, state, at(26, 10))).toEqual({ at: at(26, 12) })
    expect(patchLookAround(back, { every: 'custom' }, 0).times).toEqual(['10:30', '15:00'])
  })

  it('arms one shortest gap after the first conversation', () => {
    // 9:00 and 11:00 are two hours apart, so arming at 9:30 skips 11:00.
    const times = custom(['09:00', '11:00', '18:00'])
    expect(next(times, armed(at(26, 9, 30)), at(26, 9, 31))).toEqual({ at: at(26, 18) })
  })

  it('runs nothing for a saved Custom whose times are unreadable', () => {
    expect(
      lookAroundDecision({ ...setting, every: 'custom' }, armed(at(20, 9)), at(26, 12, 1))
    ).toEqual({ due: null })
  })
})

// Why: on Windows, unsetting a stubbed TZ doesn't restore the OS zone, so it would leak into later tests.
describe.skipIf(process.platform === 'win32')('a schedule in another zone than its host', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reads a Pacific viewer’s times on a UTC host in Pacific time', () => {
    vi.stubEnv('TZ', 'UTC')
    const times = custom(['09:30', '14:00'], { timezone: 'America/Los_Angeles' })
    // Wed Nov 11, 10:12 AM Pacific (18:12 UTC), after the 9:30 AM look (17:30 UTC) ran.
    const nineThirty = Date.parse('2026-11-11T17:30:00Z')
    const state = looked(armed(Date.parse('2026-11-02T00:00:00Z')), 'run-1', nineThirty, {
      scheduledFor: nineThirty
    })
    const now = Date.parse('2026-11-11T18:12:00Z')
    expect(next(times, state, now)).toEqual({ at: Date.parse('2026-11-11T22:00:00Z') })
    expect(lookAroundScheduleState(times, state, now, { hostZone: 'UTC' })).toMatchObject({
      timeZone: 'America/Los_Angeles',
      hostTimeZone: 'UTC',
      nextAt: Date.parse('2026-11-11T22:00:00Z')
    })
    // Saturday 10 AM Pacific is 18:00 UTC; the next look is Monday 9:30 AM Pacific.
    expect(next(times, state, Date.parse('2026-11-14T18:00:00Z'))).toEqual({
      at: Date.parse('2026-11-16T17:30:00Z')
    })
  })

  it('runs a time a clock change repeats once, and a time it skips at the end of the gap', () => {
    vi.stubEnv('TZ', 'UTC')
    const state = armed(Date.parse('2026-01-01T00:00:00Z'))
    const ny = (times: string[]) =>
      custom(times, { weekdaysOnly: false, timezone: 'America/New_York' })
    // Fall back, Nov 1: 1:30 AM happens at 05:30Z (EDT) and again at 06:30Z (EST); only the first.
    expect(next(ny(['01:30']), state, Date.parse('2026-11-01T04:00:00Z'))).toEqual({
      at: Date.parse('2026-11-01T05:30:00Z')
    })
    const tookFirst = looked(state, 'run-1', Date.parse('2026-11-01T05:30:00Z'), {
      scheduledFor: Date.parse('2026-11-01T05:30:00Z')
    })
    expect(next(ny(['01:30']), tookFirst, Date.parse('2026-11-01T05:31:00Z'))).toEqual({
      at: Date.parse('2026-11-02T06:30:00Z')
    })
    expect(lookAroundDueAt(ny(['01:30']), tookFirst, Date.parse('2026-11-01T06:31:00Z'))).toBeNull()
    // Spring forward, Mar 8: 2:30 AM doesn't happen; it runs at 3:00 AM EDT (07:00Z) that day.
    expect(next(ny(['02:30']), state, Date.parse('2026-03-08T05:00:00Z'))).toEqual({
      at: Date.parse('2026-03-08T07:00:00Z')
    })
    // Lord Howe moves half an hour, 2:00 → 2:30 on Oct 4: 2:15 runs at 2:30 (+11), 15:30Z.
    expect(
      next(
        custom(['02:15'], { weekdaysOnly: false, timezone: 'Australia/Lord_Howe' }),
        state,
        // 12:15 AM there, Oct 4.
        Date.parse('2026-10-03T13:45:00Z')
      )
    ).toEqual({ at: Date.parse('2026-10-03T15:30:00Z') })
  })
})

describe('A missed look', () => {
  it('names the latest slot whose catch-up ended untaken, behind due or completed looks', () => {
    const state = armed(at(20, 9))
    expect(lookAroundDecision(setting, state, at(26, 8, 30)).missedAt).toBe(at(23, 20))
    // 8:00 is still caught up until 12:00.
    expect(lookAroundDecision(setting, state, at(26, 9, 30)).missedAt).toBe(at(23, 20))
    expect(lookAroundDecision(setting, state, at(26, 12, 30)).missedAt).toBe(at(26, 8))
    const done = looked(state, 'run-1', at(26, 8, 1), { scheduledFor: at(26, 8) })
    expect(lookAroundDecision(setting, done, at(26, 12, 30)).missedAt).toBe(at(23, 20))
  })
})

describe('A slot that keeps failing', () => {
  it('is noted though a later look the same day succeeds', () => {
    let state = armed(at(20, 9))
    const look = (id: string, slot: number, error?: string) => {
      state = endRun(beginRun(state, id, slot, { scheduledFor: slot }), id, slot + 60_000, error)
    }
    look('mon-8', at(26, 8), 'failed')
    look('mon-12', at(26, 12))
    look('tue-8', at(27, 8), 'failed')
    look('tue-12', at(27, 12))
    expect(lookAroundScheduleState(setting, state, at(27, 13))).toMatchObject({
      repeatTrouble: { scheduledFor: at(27, 8), failed: 2, missed: 0, of: 3 }
    })
    expect(lookAroundScheduleState(setting, state, at(27, 13))).not.toHaveProperty('failedInARow')
  })
})

describe('A slot that keeps going by unrun', () => {
  it('asks the owner to step in after three days, but never turns Look around off', () => {
    const state = {
      ...armed(at(20, 9)),
      missedSlots: [at(26, 8), at(27, 8), at(28, 8)]
    }
    expect(lookAroundScheduleState(setting, state, at(28, 13))).toMatchObject({
      repeatTrouble: { scheduledFor: at(28, 8), failed: 0, missed: 3, of: 3 }
    })
    expect(lookAroundNeedsYou(setting, state, at(28, 13))).toBe(3)
    expect(lookAroundNeedsYou({ ...setting, on: false }, state, at(28, 13))).toBeUndefined()
    expect(lookAroundNeedsYou(setting, { ...state, missedSlots: [at(28, 8)] }, at(28, 13))).toBe(
      undefined
    )
  })
})

describe('Next look', () => {
  it('is never in the past unless it names a slot that is due now', () => {
    const settings = [
      setting,
      { ...setting, weekdaysOnly: false },
      custom(['00:30', '09:30', '10:30', '23:00']),
      custom(['06:15'], { weekdaysOnly: false })
    ]
    const state = looked(armed(at(19, 9)), 'run-1', at(26, 11, 30))
    for (const each of settings) {
      // Every 7 minutes across a week, weekend included.
      for (let now = at(24, 0); now < at(31, 0); now += 7 * 60_000) {
        const decided = lookAroundDecision(each, state, now).next
        expect(decided === undefined || decided.due === true || decided.at > now).toBe(true)
      }
    }
  })
})

describe('After an edit', () => {
  it('starts no second look when a time moves into the hour after a look that just ran', () => {
    const ran = looked(armed(at(20, 9)), 'run-1', at(26, 9, 30), { scheduledFor: at(26, 9, 30) })
    // At 9:50 the owner moves 9:30 to 9:45: the look at 9:30 stands in for it.
    expect(lookAroundDueAt(custom(['09:45', '14:00']), ran, at(26, 9, 50))).toBeNull()
    expect(next(custom(['09:45', '14:00']), ran, at(26, 9, 50))?.at).toBe(at(26, 14))
  })
})

describe('A missed look the owner is told about', () => {
  it('needs a receipt: a slot that went by while the bot was paused says nothing', () => {
    const state = armed(at(20, 9))
    expect(lookAroundScheduleState(setting, state, at(26, 12, 30))).not.toHaveProperty('missedAt')
    expect(
      lookAroundScheduleState(setting, { ...state, missedSlots: [at(26, 8)] }, at(26, 12, 30))
    ).toMatchObject({ missedAt: at(26, 8) })
  })

  it('still asks for the owner on Monday after a week of 8:00 AM misses', () => {
    // Monday Oct 26 to Friday Oct 30, each 8:00 AM missed; it is now Monday Nov 2 at 7:30 AM.
    const days = [26, 27, 28, 29, 30]
    const state = { ...armed(at(19, 9)), missedSlots: days.map((day) => at(day, 8)) }
    const monday = new Date(2026, 10, 2, 7, 30).getTime()
    expect(lookAroundNeedsYou(setting, state, monday)).toBe(3)
    expect(lookAroundScheduleState(setting, state, monday)).toMatchObject({
      repeatTrouble: { scheduledFor: at(30, 8), failed: 0, missed: 3, of: 3 }
    })
  })

  it('forgets a time the owner removed', () => {
    const state = { ...armed(at(19, 9)), missedSlots: [at(26, 8), at(27, 8), at(28, 8)] }
    expect(lookAroundNeedsYou(custom(['10:00', '15:00']), state, at(28, 16))).toBeUndefined()
  })
})

describe('A saved zone this host can’t read', () => {
  it('follows the host clock and says so, rather than failing the status read', () => {
    let state = armed(at(20, 9))
    state = endRun(
      beginRun(state, 'r', at(26, 8), { scheduledFor: at(26, 8) }),
      'r',
      at(26, 8, 5),
      'x'
    )
    const broken = { ...setting, timezone: 'Mars/Olympus' }
    expect(lookAroundScheduleState(broken, state, at(26, 13), { hostZone: 'UTC' })).toMatchObject({
      timeZone: 'UTC',
      zoneUnreadable: true
    })
  })
})

// Why: on Windows, unsetting a stubbed TZ doesn't restore the OS zone, so it would leak into later tests.
describe.skipIf(process.platform === 'win32')('a clock change at midnight', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('runs a skipped 12:30 AM at the first instant of that date, never the evening before', () => {
    vi.stubEnv('TZ', 'UTC')
    // The day before's 12:30 AM ran in each zone, so it isn't still caught up that evening.
    const dayBefore = (id: string, slot: string) => (state: BotLookState) =>
      looked(state, id, Date.parse(slot), { scheduledFor: Date.parse(slot) })
    const state = dayBefore(
      'havana',
      '2026-03-07T05:30:00Z'
    )(dayBefore('santiago', '2026-09-05T04:30:00Z')(armed(Date.parse('2026-01-01T00:00:00Z'))))
    const daily = (zone: string) => custom(['00:30'], { weekdaysOnly: false, timezone: zone })
    // Santiago, Sep 6 2026: midnight jumps to 1:00 AM (-04 → -03); 12:30 AM runs at 1:00 AM, 04:00Z.
    for (const now of ['2026-09-06T02:00:00Z', '2026-09-06T03:00:00Z', '2026-09-06T03:59:00Z']) {
      expect(next(daily('America/Santiago'), state, Date.parse(now))).toEqual({
        at: Date.parse('2026-09-06T04:00:00Z')
      })
    }
    expect(
      lookAroundDueAt(daily('America/Santiago'), state, Date.parse('2026-09-06T04:00:30Z'))
    ).toBe(Date.parse('2026-09-06T04:00:00Z'))
    // Havana, Mar 8 2026: midnight jumps to 1:00 AM (-05 → -04); 12:30 AM runs at 1:00 AM, 05:00Z.
    expect(next(daily('America/Havana'), state, Date.parse('2026-03-08T03:00:00Z'))).toEqual({
      at: Date.parse('2026-03-08T05:00:00Z')
    })
    expect(
      lookAroundDueAt(daily('America/Havana'), state, Date.parse('2026-03-08T05:00:30Z'))
    ).toBe(Date.parse('2026-03-08T05:00:00Z'))
  })
})

describe('unusable stored custom times', () => {
  it('runs no looks until the owner fixes the list', () => {
    const broken = custom(['09:00', '09:30'])
    expect(lookAroundDecision(broken, armed(at(20, 9)), at(26, 9, 5))).toEqual({ due: null })
  })
})

describe('Look now substitution window', () => {
  // 9:00 is caught up until 12:00, so a Look now stands in for it from 8:00 until then.
  const noon = (state: BotLookState) =>
    looked(state, 'noon', at(26, 12), { scheduledFor: at(26, 12) })
  it.each<[number, number | undefined]>([
    [-65, at(26, 9)],
    [-60, undefined],
    [0, undefined],
    [60, undefined],
    [65, undefined],
    [180, undefined],
    [185, at(26, 9)]
  ])('bounds a manual look %s minutes from the scheduled slot', (offset, expected) => {
    const schedule = custom(['09:00', '12:00'])
    const state = looked(noon(armed(at(26, 0))), 'manual', at(26, 9) + offset * 60_000)
    expect(lookAroundDecision(schedule, state, at(26, 12, 30)).missedAt).toBe(expected)
  })

  it.each<[number, number, number | undefined]>([
    [9, 65, undefined],
    [12, 60, at(26, 9)],
    [6, 60, undefined],
    [6, 185, at(26, 9)]
  ])(
    'keeps scheduled slot identity at %s and bounds obsolete runs at +%s minutes',
    (hour, offset, expected) => {
      const schedule = custom(['09:00', '12:00'])
      const state = looked(noon(armed(at(26, 0))), 'scheduled', at(26, 9) + offset * 60_000, {
        scheduledFor: at(26, hour)
      })
      expect(lookAroundDecision(schedule, state, at(26, 12, 30)).missedAt).toBe(expected)
    }
  )
})

describe('A Look now stands in for one slot', () => {
  const times = custom(['09:00', '10:00'])
  const manual = (startedAt: number) => looked(armed(at(26, 0)), 'manual', startedAt)

  it('takes the overdue slot, never the next one too', () => {
    const state = manual(at(26, 9, 30))
    expect(next(times, state, at(26, 9, 45))).toEqual({ at: at(26, 10) })
    expect(lookAroundDueAt(times, state, at(26, 10, 0, 30))).toBe(at(26, 10))
    expect(lookAroundDecision(times, state, at(26, 10, 0, 30)).missedAt).toBeUndefined()
  })

  it('takes the next slot when none is overdue', () => {
    const state = manual(at(26, 8, 30))
    expect(next(times, state, at(26, 8, 45))).toEqual({
      at: at(26, 10),
      skipped: { at: at(26, 9), lookedAt: at(26, 8, 30) }
    })
    expect(lookAroundDueAt(times, state, at(26, 9, 0, 30))).toBeNull()
    expect(lookAroundDueAt(times, state, at(26, 10, 0, 30))).toBe(at(26, 10))
  })

  it('takes only the latest of two overdue slots', () => {
    // At 10:00 both 9:00's catch-up and 10:00 have it.
    const state = manual(at(26, 10))
    const decision = lookAroundDecision(times, state, at(26, 10, 0, 30))
    expect(decision.due).toBeNull()
    expect(decision.missedAt).toBe(at(26, 9))
  })

  it('takes no slot when it started outside every window', () => {
    const state = manual(at(26, 7, 30))
    expect(next(times, state, at(26, 7, 45))).toEqual({ at: at(26, 9) })
    expect(lookAroundDueAt(times, state, at(26, 9, 0, 30))).toBe(at(26, 9))
  })
})
