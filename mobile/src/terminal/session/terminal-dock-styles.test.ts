import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_KEY_HIT_SLOP, TERMINAL_KEY_METRICS } from './terminal-dock-styles'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios }
}))

describe('terminal accessory key sizing', () => {
  it('keeps labels readable and touch targets at least 44 pt', () => {
    expect(TERMINAL_KEY_METRICS.labelSize).toBeGreaterThanOrEqual(15)
    expect(TERMINAL_KEY_METRICS.minWidth).toBeGreaterThanOrEqual(44)
    const hitHeight =
      TERMINAL_KEY_METRICS.height + TERMINAL_KEY_HIT_SLOP.top + TERMINAL_KEY_HIT_SLOP.bottom
    expect(hitHeight).toBeGreaterThanOrEqual(44)
  })
})
