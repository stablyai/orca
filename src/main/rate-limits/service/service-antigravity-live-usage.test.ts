import { describe, expect, it } from 'vitest'
import type { AntigravityStatusLineReading } from '../../../shared/agent-usage/rate-limits/antigravity-statusline-quota'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { AntigravityLiveUsage } from './service-antigravity-live-usage'

function reading(receivedAt: number, usedPercent: number, email = 'Me@Example.com') {
  const limits: ProviderRateLimits = {
    provider: 'antigravity',
    session: { usedPercent, windowMinutes: 300, resetsAt: 5_000_000, resetDescription: null },
    weekly: null,
    updatedAt: receivedAt,
    error: null,
    status: 'ok'
  }
  return { email, limits } satisfies AntigravityStatusLineReading
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
  live.setResolver({
    isEnabled: () => on,
    accountIdForEmail: async (email) => (email.toLowerCase() === 'me@example.com' ? 'acct-1' : null)
  })
  return { live, published, get: () => current, setEnabled: (value: boolean) => (on = value) }
}

describe('AntigravityLiveUsage', () => {
  it('keeps the newest reading and the time Orca first received unchanged values', async () => {
    const { live, published, get } = setup()
    await live.ingest(reading(2000, 40))
    expect(get()?.updatedAt).toBe(2000)
    expect(get()?.usageMetadata?.account).toEqual({ id: 'acct-1', email: 'Me@Example.com' })

    await live.ingest(reading(1000, 90))
    expect(get()?.session?.usedPercent).toBe(40)

    await live.ingest(reading(3000, 40))
    expect(published).toHaveLength(1)
    expect(get()?.updatedAt).toBe(2000)

    await live.ingest(reading(4000, 55))
    expect(published).toHaveLength(2)
    expect(get()).toMatchObject({ updatedAt: 4000, session: { usedPercent: 55 } })
  })

  it('leaves the account id empty when no saved account matches', async () => {
    const { live, get } = setup()
    await live.ingest(reading(2000, 10, 'other@example.com'))
    expect(get()?.usageMetadata?.account).toEqual({ id: null, email: 'other@example.com' })
  })

  it('ignores readings while the setting is off and clears what it held', async () => {
    const { live, published, get, setEnabled } = setup(false)
    await live.ingest(reading(2000, 40))
    expect(published).toHaveLength(0)

    setEnabled(true)
    await live.ingest(reading(2000, 40))
    expect(get()).not.toBeNull()
    setEnabled(false)
    live.clear()
    expect(get()).toBeNull()
    await live.ingest(reading(3000, 41))
    expect(get()).toBeNull()
  })
})
