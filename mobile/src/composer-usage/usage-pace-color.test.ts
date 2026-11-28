import { describe, expect, it, vi } from 'vitest'
import { getMobilePalette } from '../theme/mobile-theme'

const colors = getMobilePalette()
import { usagePaceColor, usagePaceTone, usageWindowPaceColor } from './usage-pace-color'

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
    expect(usagePaceColor({ kind: 'under', deltaPercent: 5 }, 40)).toBe(colors.statusGreen)
    expect(usagePaceColor({ kind: 'on-pace', deltaPercent: 1 }, 40)).toBe(colors.statusGreen)
    expect(usagePaceColor({ kind: 'ahead', deltaPercent: 10, runOutBeforeResetMs: null }, 40)).toBe(
      colors.statusAmber
    )
    expect(usagePaceColor({ kind: 'ahead', deltaPercent: 10, runOutBeforeResetMs: 1000 }, 40)).toBe(
      colors.statusRed
    )
    expect(usagePaceColor({ kind: 'exhausted' }, 100)).toBe(colors.statusRed)
  })

  it('falls back to the used-level band without a pace', () => {
    expect(usagePaceColor({ kind: 'unknown' }, 90)).toBe('band:90')
    expect(usagePaceColor({ kind: 'unknown' }, null)).toBe('band:null')
  })
})

describe('usageWindowPaceColor', () => {
  // Halfway through a 5-hour window, even pace is 50%.
  const now = 1_700_000_000_000
  const window = {
    usedPercent: 20,
    windowMinutes: 300,
    resetsAt: now + 150 * 60_000
  }

  it('stays green through the green threshold, yellow through the yellow one, and red past it', () => {
    expect(usageWindowPaceColor({ ...window, usedPercent: 55 }, now)).toBe(colors.statusGreen)
    expect(usageWindowPaceColor({ ...window, usedPercent: 56 }, now)).toBe(colors.statusAmber)
    expect(usageWindowPaceColor({ ...window, usedPercent: 62 }, now)).toBe(colors.statusRed)
    expect(usageWindowPaceColor({ ...window, usedPercent: 100 }, now)).toBe(colors.statusRed)
    expect(
      usageWindowPaceColor({ ...window, usedPercent: 62 }, now, {
        greenMaxOverPacePct: 15,
        yellowMaxOverPacePct: 20
      })
    ).toBe(colors.statusGreen)
  })
})
