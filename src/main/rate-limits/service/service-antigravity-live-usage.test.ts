import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { AntigravityLiveUsage } from './service-antigravity-live-usage'

function reading(updatedAt: number, usedPercent: number, email?: string): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: { usedPercent, windowMinutes: 300, resetsAt: 5_000_000, resetDescription: null },
    weekly: null,
    buckets: [
      {
        name: 'Gemini 5h',
        usedPercent,
        windowMinutes: 300,
        resetsAt: 5_000_000,
        resetDescription: null
      }
    ],
    updatedAt,
    error: null,
    status: 'ok',
    ...(email ? { usageMetadata: { account: { email } } } : {})
  }
}

function setup(enabled = true) {
  let current: ProviderRateLimits | null = null
  const published: (ProviderRateLimits | null)[] = []
  let on = enabled
  const live = new AntigravityLiveUsage({
    current: () => current,
    publish: (next) => {
      current = next
      published.push(next)
    }
  })
  live.setEnabledResolver(() => on)
  return { live, published, get: () => current, setEnabled: (value: boolean) => (on = value) }
}

describe('AntigravityLiveUsage', () => {
  it('keeps the time Orca first received unchanged windows and bumps it on a change', () => {
    const { live, published, get } = setup()
    live.ingest(reading(2000, 40))
    live.ingest(reading(3000, 40))
    expect(published).toHaveLength(1)
    expect(get()?.updatedAt).toBe(2000)

    live.ingest(reading(4000, 55))
    expect(get()).toMatchObject({ updatedAt: 4000, session: { usedPercent: 55 } })
  })

  it('publishes again when the same windows now come from another login', () => {
    const { live, get } = setup()
    live.ingest(reading(2000, 40, 'a@example.com'))
    live.ingest(reading(3000, 40, 'b@example.com'))
    expect(get()).toMatchObject({
      updatedAt: 3000,
      usageMetadata: { account: { email: 'b@example.com' } }
    })
  })

  it('lets the last post to arrive win, whatever its timestamp says', () => {
    const { live, get } = setup()
    live.ingest(reading(2000, 40))
    live.ingest(reading(2000, 60))
    expect(get()?.session?.usedPercent).toBe(60)
    // The clock moved back: the newer post still replaces the held reading.
    live.ingest(reading(1000, 70))
    expect(get()).toMatchObject({ updatedAt: 1000, session: { usedPercent: 70 } })
  })

  it('clears the held reading when a report arrives with no usable pool', () => {
    const { live, get } = setup()
    live.ingest(reading(2000, 40))
    live.ingest({ ...reading(3000, 0), session: null, buckets: [] })
    expect(get()).toBeNull()
  })

  it('ignores readings while the setting is off and clears what it held', () => {
    const { live, published, get, setEnabled } = setup(false)
    live.ingest(reading(2000, 40))
    expect(published).toHaveLength(0)

    setEnabled(true)
    live.ingest(reading(2000, 40))
    expect(get()).not.toBeNull()
    setEnabled(false)
    live.clear()
    expect(get()).toBeNull()
    live.ingest(reading(3000, 41))
    expect(get()).toBeNull()
  })
})
