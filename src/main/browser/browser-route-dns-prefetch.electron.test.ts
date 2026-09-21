import { describe, expect, it } from 'vitest'
import { runBrowserRouteDnsPrefetchProbe } from './browser-route-dns-prefetch-fixture'

// Why: this is a tripwire over an accepted residual, not a guard. Electron's NetworkHintsHandlerImpl overrides
// Preconnect but inherits PrefetchDNS, so `<link rel="dns-prefetch">` in a route partition resolves on the desktop
// resolver, outside the tunnel. It is not fixable per-partition in Electron 43; the upstream patch is the real fix.
// When that lands, flip the two "leaks" assertions below to expect an empty probeHostResolverEvents.
describe('browser route DNS prefetch under Electron', () => {
  it('leaks a dns-prefetch hostname to the desktop resolver despite the SOCKS partition', async () => {
    const probe = await runBrowserRouteDnsPrefetchProbe()

    expect(probe.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)

    // Leaks today: the resolver opened a job for the prefetched host.
    expect(probe.probeHostResolverEvents).toContain('HOST_RESOLVER_MANAGER_CREATE_JOB')
    // Leaks today: it ran that job locally. Neither task type traverses the partition's SOCKS proxy.
    expect(
      probe.probeHostResolverEvents.some((name) => /^HOST_RESOLVER_(SYSTEM|DNS)_TASK$/.test(name))
    ).toBe(true)

    // A host the page never references must produce nothing, or the netLog scan would pass on anything.
    expect(probe.controlHostResolverEvents).toEqual([])
  }, 90_000)
})
