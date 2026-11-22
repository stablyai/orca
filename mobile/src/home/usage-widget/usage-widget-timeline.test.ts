import { describe, expect, it, vi } from 'vitest'
import { buildUsageWidgetTimeline } from './usage-widget-timeline'

// The timeline reuses UsageBar's formatting helpers; its components never render here.
vi.mock('react-native', () => ({
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios }
}))

const containsNull = (value: unknown): boolean =>
  value === null || (typeof value === 'object' && Object.values(value).some(containsNull))

describe('buildUsageWidgetTimeline', () => {
  // expo-widgets stores props in UserDefaults, which throws on NSNull.
  it('leaves absent windows, resets and icons out instead of writing null', () => {
    const entries = buildUsageWidgetTimeline({
      summary: {
        hosts: [
          {
            id: 'studio',
            name: 'Studio',
            providers: [
              {
                provider: 'grok',
                updatedAt: 1000,
                session: null,
                weekly: { usedPercent: 64, resetsAt: null }
              }
            ]
          }
        ]
      },
      now: 2000,
      display: 'used',
      icons: {},
      url: 'orca:///?tab=usage',
      t: (_key, fallback) => fallback
    })

    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((entry) => containsNull(entry.props))).toBe(false)
  })
})
