import { describe, expect, it } from 'vitest'
import { runBrowserRouteDnsPrefetchProbe } from './browser-route-dns-prefetch-fixture'

// This records the Electron 43 DNS-prefetch leak outside SOCKS; invert the leak assertions after an upstream fix.
describe('browser route DNS prefetch under Electron', () => {
  it('leaks a dns-prefetch hostname to the desktop resolver despite the SOCKS partition', async () => {
    const probe = await runBrowserRouteDnsPrefetchProbe()

    expect(probe.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)

    expect(probe.probeHostResolverEvents).toContain('HOST_RESOLVER_MANAGER_CREATE_JOB')
    expect(
      probe.probeHostResolverEvents.some((name) => /^HOST_RESOLVER_(SYSTEM|DNS)_TASK$/.test(name))
    ).toBe(true)

    expect(probe.controlHostResolverEvents).toEqual([])
  }, 90_000)
})
