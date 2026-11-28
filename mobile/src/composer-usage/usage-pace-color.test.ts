import { describe, expect, it, vi } from 'vitest'
import { getMobilePalette } from '../theme/mobile-theme'

const colors = getMobilePalette()
import { usagePaceColor, usagePaceTone } from './usage-pace-color'

vi.mock('../accounts/usage/UsageBar', () => ({
  usageBandColor: (usedPercent: number | null) => `band:${usedPercent}`
}))

describe('usagePaceTone', () => {
  it('turns ahead over once the burn would run out before reset', () => {
    expect(usagePaceTone({ kind: 'ahead', deltaPercent: 10, runOutBeforeResetMs: null })).toBe(
      'ahead'
    )
    expect(usagePaceTone({ kind: 'ahead', deltaPercent: 10, runOutBeforeResetMs: 1000 })).toBe(
      'over'
    )
    expect(usagePaceTone({ kind: 'exhausted' })).toBe('over')
    expect(usagePaceTone({ kind: 'unknown' })).toBe('unpaced')
  })
})

describe('usagePaceColor', () => {
  it('colors the window by pace: green on or under, amber ahead, red over', () => {
    expect(usagePaceColor({ kind: 'under', deltaPercent: 5 }, 40, colors)).toBe(colors.statusGreen)
    expect(usagePaceColor({ kind: 'on-pace', deltaPercent: 1 }, 40, colors)).toBe(
      colors.statusGreen
    )
    expect(
      usagePaceColor({ kind: 'ahead', deltaPercent: 10, runOutBeforeResetMs: null }, 40, colors)
    ).toBe(colors.statusAmber)
    expect(
      usagePaceColor({ kind: 'ahead', deltaPercent: 10, runOutBeforeResetMs: 1000 }, 40, colors)
    ).toBe(colors.statusRed)
    expect(usagePaceColor({ kind: 'exhausted' }, 100, colors)).toBe(colors.statusRed)
  })

  it('falls back to the used-level band without a pace', () => {
    expect(usagePaceColor({ kind: 'unknown' }, 90, colors)).toBe('band:90')
    expect(usagePaceColor({ kind: 'unknown' }, null, colors)).toBe('band:null')
  })
})
