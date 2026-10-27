import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportDailyRelayActivity, watchDailyRelayActivity } from './legacy-relay-daily-activity'

const report = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T23:30:00Z'))
  watchDailyRelayActivity(null, () => [])
  report.mockClear()
})
afterEach(() => {
  watchDailyRelayActivity(null, () => [])
  vi.useRealTimers()
})

describe('the daily legacy relay activity row', () => {
  it('reports each target once per UTC day while it bridges terminals', () => {
    reportDailyRelayActivity('a', 2, report)
    reportDailyRelayActivity('a', 3, report)
    reportDailyRelayActivity('b', 1, report)
    vi.setSystemTime(new Date('2026-10-19T00:01:00Z'))
    reportDailyRelayActivity('a', 1, report)
    expect(report.mock.calls).toEqual([
      ['a', 'active', 2],
      ['b', 'active', 1],
      ['a', 'active', 1]
    ])
  })

  it('reports nothing while no terminal is bridged, and keeps the day open for a later one', () => {
    reportDailyRelayActivity('a', 0, report)
    expect(report).not.toHaveBeenCalled()
    reportDailyRelayActivity('a', 1, report)
    expect(report).toHaveBeenCalledWith('a', 'active', 1)
  })

  it('reports a terminal left bridged across midnight with no other activity', async () => {
    watchDailyRelayActivity({ report }, () => [['a', 1] as const])
    reportDailyRelayActivity('a', 1, report)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(report.mock.calls).toEqual([
      ['a', 'active', 1],
      ['a', 'active', 1]
    ])
  })

  it('stops checking once the bridge is uninstalled', async () => {
    watchDailyRelayActivity({ report }, () => [['a', 1] as const])
    watchDailyRelayActivity(null, () => [])
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(report).not.toHaveBeenCalled()
  })
})
