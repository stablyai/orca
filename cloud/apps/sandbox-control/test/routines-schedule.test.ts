import { describe, expect, it } from 'vitest'
import {
  ScheduleError,
  latestRunAtOrBefore,
  minIntervalMinutes,
  nextRunAfter,
  parseRoutineSchedule,
  zoneOffset
} from '../src/routines/schedule'
import { parseCronExpression } from '../src/routines/shared-scheduling.js'

const iso = (value: string) => Date.parse(value)
const next = (cron: string, tz: string, after: string) => {
  const at = nextRunAfter(parseRoutineSchedule(cron, tz, { allowFrequent: true }), tz, iso(after))
  return at === null ? null : new Date(at).toISOString()
}

describe('routine schedules', () => {
  it('uses the shared desktop cron parser (the .d.ts boundary matches its runtime shape)', () => {
    const rule = parseCronExpression('0 9 * * 1-5')
    expect(rule.kind).toBe('cron')
    expect([...rule.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5])
    expect(rule.dayOfWeekRestricted).toBe(true)
    expect(rule.dayOfMonthRestricted).toBe(false)
    // Same dialect quirk as the desktop: both day fields restricted = either matches.
    const either = parseCronExpression('0 9 13 * 5')
    expect(either.dayOfMonthRestricted && either.dayOfWeekRestricted).toBe(true)
  })

  it('runs weekdays at 09:00 in the routine time zone, skipping the weekend', () => {
    // Friday 2026-11-13 10:00 New York (EST, -5) -> Monday 09:00 EST.
    expect(next('0 9 * * 1-5', 'America/New_York', '2026-11-13T15:00:00Z')).toBe('2026-11-16T14:00:00.000Z')
    // Same rule in Tokyo (no DST, +9).
    expect(next('0 9 * * 1-5', 'Asia/Tokyo', '2026-11-13T00:30:00Z')).toBe('2026-11-16T00:00:00.000Z')
    // Before 09:00 on a weekday: today.
    expect(next('0 9 * * 1-5', 'Europe/Berlin', '2026-11-10T06:00:00Z')).toBe('2026-11-10T08:00:00.000Z')
  })

  it('follows the offset change across DST (9am stays 9am local)', () => {
    // US DST ends 2026-11-01: 09:00 EDT = 13:00Z on Oct 30, 09:00 EST = 14:00Z on Nov 2.
    expect(next('0 9 * * *', 'America/New_York', '2026-10-31T13:30:00Z')).toBe('2026-11-01T14:00:00.000Z')
    expect(next('0 9 * * *', 'America/New_York', '2026-10-30T12:00:00Z')).toBe('2026-10-30T13:00:00.000Z')
    // Spring forward 2026-03-08.
    expect(next('0 9 * * *', 'America/New_York', '2026-03-07T15:00:00Z')).toBe('2026-03-08T13:00:00.000Z')
  })

  it('runs a wall time skipped by spring-forward once, as the gap ends', () => {
    // 02:30 does not exist in New York on 2026-03-08 (02:00 EST -> 03:00 EDT at 07:00Z).
    expect(next('30 2 * * *', 'America/New_York', '2026-03-08T05:00:00Z')).toBe('2026-03-08T07:00:00.000Z')
    // Next day it is a normal 02:30 EDT.
    expect(next('30 2 * * *', 'America/New_York', '2026-03-08T07:00:00Z')).toBe('2026-03-09T06:30:00.000Z')
  })

  it('runs a repeated fall-back wall time only once', () => {
    // 01:30 happens at 05:30Z (EDT) and 06:30Z (EST) on 2026-11-01.
    expect(next('30 1 * * *', 'America/New_York', '2026-11-01T04:00:00Z')).toBe('2026-11-01T05:30:00.000Z')
    expect(next('30 1 * * *', 'America/New_York', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z')
    // Starting inside the second pass: still not a second run.
    expect(next('30 1 * * *', 'America/New_York', '2026-11-01T06:10:00Z')).toBe('2026-11-02T06:30:00.000Z')
    // Hourly rules still fire every real hour through the change.
    expect(next('0 * * * *', 'America/New_York', '2026-11-01T05:10:00Z')).toBe('2026-11-01T06:00:00.000Z')
  })

  it('handles half-hour zones and half-hour DST shifts (Lord Howe)', () => {
    expect(zoneOffset('Asia/Kolkata', iso('2026-01-01T00:00:00Z'))).toBe(5.5 * 3_600_000)
    expect(next('0 9 * * *', 'Asia/Kolkata', '2026-01-01T00:00:00Z')).toBe('2026-01-01T03:30:00.000Z')
    // Lord Howe goes +10:30 -> +11 at 02:00 local on 2026-10-04; 02:15 never happens.
    expect(next('15 2 * * *', 'Australia/Lord_Howe', '2026-10-03T14:00:00Z')).toBe('2026-10-03T15:30:00.000Z')
  })

  it('finds rare dates (Feb 29) and month/day-of-month rules', () => {
    expect(next('0 0 29 2 *', 'UTC', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z')
    expect(next('0 12 1 * *', 'Europe/London', '2026-11-09T00:00:00Z')).toBe('2026-12-01T12:00:00.000Z')
  })

  it('validates cron, time zone and the 15-minute cost guard', () => {
    const reason = (cron: string, tz = 'UTC') => {
      try {
        parseRoutineSchedule(cron, tz)
        return 'ok'
      } catch (error) {
        return (error as ScheduleError).reason
      }
    }
    expect(reason('0 9 * * 1-5', 'America/New_York')).toBe('ok')
    expect(reason('*/15 * * * *')).toBe('ok')
    expect(reason('0 9 * *')).toBe('invalid_cron')
    expect(reason('61 9 * * *')).toBe('invalid_cron')
    expect(reason('0 9 31 2 *')).toBe('invalid_cron') // never fires
    expect(reason('0 9 * * *', 'Mars/Olympus')).toBe('invalid_timezone')
    expect(reason('* * * * *')).toBe('too_frequent')
    expect(reason('*/5 * * * *')).toBe('too_frequent')
    expect(reason('0,10 9 * * *')).toBe('too_frequent')
    // 09:55 then 10:05 is 10 minutes apart across the hour.
    expect(reason('5,55 9-10 * * *')).toBe('too_frequent')
    expect(reason('5,55 9 * * *')).toBe('ok')
    expect(minIntervalMinutes(parseCronExpression('0 * * * *'))).toBe(60)
    expect(() => parseRoutineSchedule('* * * * *', 'UTC', { allowFrequent: true })).not.toThrow()
  })

  it('finds the latest missed slot within a window (missed-run policy)', () => {
    const rule = parseRoutineSchedule('*/15 * * * *', 'UTC')
    expect(new Date(latestRunAtOrBefore(rule, 'UTC', iso('2026-11-09T09:00:00Z'), iso('2026-11-09T09:40:00Z'))!).toISOString()).toBe('2026-11-09T09:30:00.000Z')
    expect(latestRunAtOrBefore(rule, 'UTC', iso('2026-11-09T09:00:00Z'), iso('2026-11-09T09:10:00Z'))).toBeNull()
  })

  it('is fast enough for the Worker (sparse rules scan by day, not by minute)', () => {
    const started = performance.now()
    for (let i = 0; i < 50; i++) {
      next('0 9 * * 1-5', 'America/New_York', '2026-11-13T15:00:00Z')
    }
    next('0 0 29 2 *', 'Europe/Berlin', '2026-03-01T00:00:00Z')
    expect(performance.now() - started).toBeLessThan(1500)
  })
})
