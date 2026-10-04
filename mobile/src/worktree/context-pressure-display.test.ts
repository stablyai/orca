import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentContextPressure } from '../../../src/shared/runtime-types'
import { formatContextPressurePercent, worstAgentContextPressure } from './context-pressure-display'

function row(contextPressure?: RuntimeWorktreeAgentContextPressure) {
  return contextPressure ? { contextPressure } : {}
}

describe('worstAgentContextPressure', () => {
  it('returns null for empty lists and rows without host-computed pressure', () => {
    expect(worstAgentContextPressure([])).toBeNull()
    // Absent field = gate off, no provider data, or an older host — honest nothing.
    expect(worstAgentContextPressure([row(), row()])).toBeNull()
  })

  it('stays quiet at ok, mirroring the desktop aggregate policy', () => {
    expect(worstAgentContextPressure([row({ level: 'ok', usedPercent: 42 })])).toBeNull()
  })

  it('picks the worst level across agents', () => {
    const worst = worstAgentContextPressure([
      row({ level: 'warning', usedPercent: 88 }),
      row({ level: 'critical', usedPercent: 91 }),
      row({ level: 'ok', usedPercent: 10 }),
      row()
    ])
    expect(worst).toEqual({ level: 'critical', usedPercent: 91 })
  })

  it('breaks level ties toward the higher usedPercent', () => {
    const worst = worstAgentContextPressure([
      row({ level: 'warning', usedPercent: 71 }),
      row({ level: 'warning', usedPercent: 84 }),
      row({ level: 'warning', usedPercent: 76 })
    ])
    expect(worst).toEqual({ level: 'warning', usedPercent: 84 })
  })
})

describe('formatContextPressurePercent', () => {
  it('renders whole percents', () => {
    expect(formatContextPressurePercent(75)).toBe('75%')
    expect(formatContextPressurePercent(0)).toBe('0%')
    expect(formatContextPressurePercent(100)).toBe('100%')
  })

  it('guards against out-of-range or invalid host values', () => {
    expect(formatContextPressurePercent(-5)).toBe('0%')
    expect(formatContextPressurePercent(1000)).toBe('100%')
    expect(formatContextPressurePercent(75.4)).toBe('75%')
    expect(formatContextPressurePercent(Number.NaN)).toBe('0%')
    expect(formatContextPressurePercent(Number.POSITIVE_INFINITY)).toBe('0%')
  })
})
