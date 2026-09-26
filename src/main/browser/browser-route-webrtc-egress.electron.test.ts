import { afterAll, describe, expect, it } from 'vitest'
import {
  cleanupBrowserRouteWebrtcEgressFixtures,
  runBrowserRouteWebrtcEgressProbe
} from './browser-route-webrtc-egress-fixture'

afterAll(cleanupBrowserRouteWebrtcEgressFixtures)

describe('browser route WebRTC egress under Electron', () => {
  it('blocks direct UDP after applying the exact guest policy', async () => {
    const baseline = await runBrowserRouteWebrtcEgressProbe(false)
    const protectedGuest = await runBrowserRouteWebrtcEgressProbe(true)

    expect(protectedGuest.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)
    expect(baseline.packets).toBeGreaterThan(0)
    expect(protectedGuest.policy).toBe('disable_non_proxied_udp')
    expect(protectedGuest.packets).toBe(0)
  }, 150_000)
})
