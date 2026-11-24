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
      linkFor: () => 'orca:///?tab=usage',
      t: (_key, fallback) => fallback
    })

    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((entry) => containsNull(entry.props))).toBe(false)
  })

  // The widget only redraws at entries, so the hour boundary needs one or old numbers pass as fresh.
  it('dims an agent at the first entry past an hour without an update', () => {
    const now = 1_000_000
    const entries = buildUsageWidgetTimeline({
      summary: {
        hosts: [
          {
            id: 'studio',
            name: 'Studio',
            providers: [
              {
                provider: 'grok',
                updatedAt: now,
                session: { usedPercent: 10, resetsAt: null },
                weekly: null
              }
            ]
          }
        ]
      },
      now,
      display: 'used',
      icons: {},
      linkFor: () => 'orca:///?tab=usage',
      t: (_key, fallback) => fallback
    })

    const firstStale = entries.find((entry) => entry.props.hosts[0]?.agents[0]?.stale)
    expect(firstStale?.date.getTime()).toBe(now + 60 * 60_000 + 1)
  })
})
