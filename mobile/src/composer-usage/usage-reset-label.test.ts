import { describe, expect, it } from 'vitest'
import { usageResetLabel } from './usage-reset-label'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const weekly = (resetsIn: number | null) => ({
  windowMinutes: 7 * 24 * 60,
  resetsAt: resetsIn === null ? null : NOW + resetsIn
})

describe('usageResetLabel', () => {
  it('floors the time left to two units, or the largest one when compact', () => {
    const cases: [number, string, string][] = [
      [3 * DAY + 2 * HOUR + 59 * MIN, '3d 2h', '3d'],
      [6 * DAY, '6d', '6d'],
      [5 * HOUR + 20 * MIN + 30_000, '5h 20m', '5h'],
      [DAY - 1, '23h 59m', '23h'],
      [40 * MIN + 59_000, '40m', '40m'],
      [MIN, '1m', '1m'],
      [59_000, '<1m', '<1m'],
      [0, 'now', 'now'],
      [-5 * MIN, 'now', 'now']
    ]
    for (const [left, full, compact] of cases) {
      expect(usageResetLabel(weekly(left), NOW)).toBe(full)
      expect(usageResetLabel(weekly(left), NOW, 'compact')).toBe(compact)
    }
  })

  it('falls back to the window length without a reset time', () => {
    expect(usageResetLabel(weekly(null), NOW)).toBe('7d')
    expect(usageResetLabel({ windowMinutes: 300, resetsAt: null }, NOW, 'compact')).toBe('5h')
  })
})
