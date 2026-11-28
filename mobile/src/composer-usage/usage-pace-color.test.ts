import { describe, expect, it, vi } from 'vitest'
import { getMobilePalette } from '../theme/mobile-theme'

const colors = getMobilePalette()
import {
  usagePaceColor,
  usagePaceColorBand,
  usagePaceTone,
  usageWindowPaceColor
} from './usage-pace-color'

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

describe('usagePaceColorBand', () => {
  const now = 1_000_000

  it('keeps the default boundaries: green through +5, yellow through +10, then red', () => {
    expect(usagePaceColorBand(20, 15, null)).toBe('green')
    expect(usagePaceColorBand(20.1, 15.1, null)).toBe('green')
    expect(usagePaceColorBand(21, 15, null)).toBe('yellow')
    expect(usagePaceColorBand(25, 15, null)).toBe('yellow')
    expect(usagePaceColorBand(25.2, 15, null)).toBe('red')
    expect(usagePaceColorBand(null, 15, null)).toBeNull()
  })

  it('colors a full window red and a window without a reset by the used band', () => {
    expect(
      usageWindowPaceColor(
        { usedPercent: 100, windowMinutes: 60, resetsAt: now + 30 * 60_000 },
        now,
        null,
        colors
      )
    ).toBe(colors.statusRed)
    expect(
      usageWindowPaceColor(
        { usedPercent: 90, windowMinutes: 60, resetsAt: null },
        now,
        null,
        colors
      )
    ).toBe('band:90')
  })
})
