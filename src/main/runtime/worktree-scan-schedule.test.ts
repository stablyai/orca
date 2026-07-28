import { beforeEach, describe, expect, it } from 'vitest'
import {
  COLD_REFRESH_CAP_MS,
  HOT_REFRESH_FLOOR_MS,
  WorktreeScanSchedule
} from './worktree-scan-schedule'

let clock = 0
let rand = 0.5 // 0.5 => zero jitter, so tiers are exact unless a test overrides
const make = (): WorktreeScanSchedule =>
  new WorktreeScanSchedule({ now: () => clock, random: () => rand })

beforeEach(() => {
  clock = 0
  rand = 0.5
})

describe('WorktreeScanSchedule', () => {
  it('treats an unseen repo as due, and not-due until its interval elapses', () => {
    const schedule = make()
    expect(schedule.isDue('r')).toBe(true)

    schedule.recordRefresh('r', true)
    expect(schedule.isDue('r')).toBe(false)

    clock = HOT_REFRESH_FLOOR_MS - 1
    expect(schedule.isDue('r')).toBe(false)
    clock = HOT_REFRESH_FLOOR_MS
    expect(schedule.isDue('r')).toBe(true)
  })

  it('holds a hot repo at the floor across repeated refreshes', () => {
    const schedule = make()
    schedule.recordRefresh('r', true)
    clock = HOT_REFRESH_FLOOR_MS
    const dueAt = schedule.recordRefresh('r', true)
    expect(dueAt).toBe(clock + HOT_REFRESH_FLOOR_MS)
  })

  it('backs a cold repo off by doubling, capped', () => {
    const schedule = make()
    const intervals: number[] = []
    let last = 0
    // First refresh cold: doubles from the floor default.
    for (let i = 0; i < 8; i += 1) {
      const dueAt = schedule.recordRefresh('r', false)
      intervals.push(dueAt - clock)
      clock = dueAt
      last = dueAt
    }
    // 120s, 240s, 480s ... then capped at 1h.
    expect(intervals[0]).toBe(2 * HOT_REFRESH_FLOOR_MS)
    expect(intervals[1]).toBe(4 * HOT_REFRESH_FLOOR_MS)
    expect(intervals.at(-1)).toBe(COLD_REFRESH_CAP_MS)
    expect(last).toBeGreaterThan(0)
  })

  it('resets backoff to the floor the moment a repo goes hot again', () => {
    const schedule = make()
    schedule.recordRefresh('r', false)
    schedule.recordRefresh('r', false) // now backed off to 4x floor
    const dueAt = schedule.recordRefresh('r', true)
    expect(dueAt - clock).toBe(HOT_REFRESH_FLOOR_MS)
  })

  it('applies ±25% jitter so cold-cap repos spread ~45–75min', () => {
    const scheduleLow = new WorktreeScanSchedule({ now: () => 0, random: () => 0 })
    const scheduleHigh = new WorktreeScanSchedule({ now: () => 0, random: () => 1 })
    // Drive both to the cap.
    let low = 0
    let high = 0
    for (let i = 0; i < 10; i += 1) {
      low = scheduleLow.recordRefresh('r', false)
      high = scheduleHigh.recordRefresh('r', false)
    }
    expect(low).toBe(COLD_REFRESH_CAP_MS * 0.75) // 45min
    expect(high).toBe(COLD_REFRESH_CAP_MS * 1.25) // 75min
  })

  it('forgets per-repo state', () => {
    const schedule = make()
    schedule.recordRefresh('r', true)
    expect(schedule.isDue('r')).toBe(false)
    schedule.forget('r')
    expect(schedule.isDue('r')).toBe(true)
  })
})
