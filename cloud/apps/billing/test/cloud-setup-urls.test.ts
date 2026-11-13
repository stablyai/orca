import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupPagesConfigError, setupPageUrl } from '../src/cloud-setup-urls'
import { createHarness } from './harness'

const NOW = Date.UTC(2026, 0, 15)

describe('CLOUD_SETUP_PAGES_URL', () => {
  // The harness and jose read Date; pin it so no wall clock is involved.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('falls back to the current auth origin outside prod when unset', async () => {
    for (const BILLING_ENV of [undefined, 'dev', 'staging']) {
      const { env } = await createHarness({ BILLING_ENV })
      expect(setupPageUrl(env, '/start', { session: 's1' })).toBe('https://auth.onorca.dev/cloud/setup/start?session=s1')
    }
  })

  it('uses the configured origin in every environment', async () => {
    for (const BILLING_ENV of ['dev', 'prod']) {
      const { env } = await createHarness({ BILLING_ENV, CLOUD_SETUP_PAGES_URL: 'https://pages.test/' })
      expect(setupPageUrl(env, '/plan', { session: 's1' })).toBe('https://pages.test/cloud/setup/plan?session=s1')
    }
  })

  it('is a configuration error in prod when unset, answered as billing_misconfigured', async () => {
    const h = await createHarness({ BILLING_ENV: 'prod' })
    expect(() => setupPageUrl(h.env, '/start', { session: 's1' })).toThrow(SetupPagesConfigError)
    const token = await h.desktopToken({ sub: 'u1', email: 'neil@acme.dev' })
    const created = await h.call('POST', '/v1/cloud-setup/sessions', {
      body: { repo: 'https://github.com/acme/web', needs: ['plan'], device: 'MacBook Pro' },
      headers: { authorization: `Bearer ${token}` }
    })
    expect(created).toEqual({ status: 503, body: { error: 'billing_misconfigured' } })
  })
})
