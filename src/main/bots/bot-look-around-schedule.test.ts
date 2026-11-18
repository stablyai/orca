import { describe, expect, it } from 'vitest'
import { LOOK_AROUND_DEFAULTS } from '../../shared/bots/bot-look-around'
import { beginRun, EMPTY_BOT_LOOK, endRun, type BotLookState } from './bot-look-around-state'
import { lookAroundDueAt, lookAroundNextAt } from './bot-look-around-schedule'

// Local times, as the host reads its hours: Monday 2026-10-26.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()
const armed = (time: number): BotLookState => ({ ...EMPTY_BOT_LOOK, armedAt: time })
const setting = LOOK_AROUND_DEFAULTS

describe('Look around hours', () => {
  it('waits one interval after the first conversation, then takes the next slot', () => {
    const state = armed(at(26, 9, 30))
    expect(lookAroundDueAt(setting, state, at(26, 12, 1))).toBeNull()
    expect(lookAroundNextAt(setting, state, at(26, 12, 1))).toBe(at(26, 16))
    expect(lookAroundDueAt(setting, state, at(26, 16, 1))).toBe(at(26, 16))
  })

  it('looks nowhere before the first conversation', () => {
    expect(lookAroundDueAt(setting, EMPTY_BOT_LOOK, at(26, 16, 1))).toBeNull()
    expect(lookAroundNextAt(setting, EMPTY_BOT_LOOK, at(26, 16, 1))).toBeUndefined()
  })

  it('takes each slot once, and catches a missed one up the same day, never the next', () => {
    const state = armed(at(20, 9))
    const looked = beginRun(state, 'run-1', at(26, 16, 1))
    expect(lookAroundDueAt(setting, looked, at(26, 16, 30))).toBeNull()
    // The host slept through 16:00 and woke at 17:30.
    expect(lookAroundDueAt(setting, state, at(26, 17, 30))).toBe(at(26, 16))
    // Asleep from before 20:00 until the next morning: yesterday's slot is not caught up.
    expect(lookAroundDueAt(setting, state, at(27, 7, 30))).toBeNull()
  })

  it("never gives up a slot the host's sleep keeps cutting short, spacing the tries", () => {
    let state = armed(at(20, 9))
    // Four looks cut short, each a quarter hour after the last ended: the slot stays owed.
    for (const [index, minute] of [1, 25, 50, 75].entries()) {
      expect(lookAroundDueAt(setting, state, at(26, 16, minute))).toBe(at(26, 16))
      state = endRun(
        beginRun(state, `run-${index}`, at(26, 16, minute)),
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
    expect(lookAroundDueAt(setting, state, at(26, 17, 25), false)).toBe(at(26, 16))
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
    expect(lookAroundNextAt(setting, limited, at(26, 16, 1))).toBe(at(26, 17))
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
    expect(lookAroundNextAt(setting, limited, at(26, 16, 3))).toBe(at(26, 16, 17))
  })

  it('never catches up a slot from before Look around was turned back on', () => {
    const state = armed(at(20, 9))
    const back = { ...setting, since: at(26, 13) }
    expect(lookAroundDueAt(back, state, at(26, 13, 1))).toBeNull()
    expect(lookAroundDueAt(back, state, at(26, 16, 1))).toBe(at(26, 16))
  })

  it('lets a Look now just before a slot stand in for it', () => {
    const lookedNow = beginRun(armed(at(20, 9)), 'run-1', at(26, 15, 30))
    expect(lookAroundDueAt(setting, lookedNow, at(26, 16, 1))).toBeNull()
    expect(lookAroundDueAt(setting, lookedNow, at(26, 20, 1))).toBe(at(26, 20))
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
