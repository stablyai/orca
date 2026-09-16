import { describe, expect, it } from 'vitest'
import { runBrowserRouteH3EgressProbe } from './browser-route-h3-egress-fixture'

describe('browser route HTTP/3 and Direct Sockets egress under Electron', () => {
  it('keeps every UDP egress path off the desktop and hides the renderer-killing constructors', async () => {
    const baseline = await runBrowserRouteH3EgressProbe(false)
    const guarded = await runBrowserRouteH3EgressProbe(true)

    expect(baseline.resolvedProxy).toBe('DIRECT')
    expect(guarded.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)

    // WebTransport: the direct control reaches the H3 endpoint over UDP, the route partition sends nothing.
    expect(baseline.webTransportPackets).toBeGreaterThan(0)
    expect(guarded.webTransport).toMatch(/^rejected:/)
    expect(guarded.webTransportPackets).toBe(0)

    // Forced QUIC is the most aggressive path Chromium has; ShouldForceQuic refuses a non-direct proxy chain.
    expect(baseline.forcedQuicPackets).toBeGreaterThan(0)
    expect(guarded.forcedQuicPackets).toBe(0)

    // Direct Sockets: the control proves an explicit enable exposes the constructors and that reaching one kills
    // the guest renderer, which is the crash-telemetry hazard the shipped disable-features list exists to remove.
    expect(baseline.directSockets).toEqual({ tcp: 'function', udp: 'function', server: 'function' })
    // The constructor is reachable; whether it returns before ReportBadMessage lands is a race, so the kill is the oracle.
    expect(baseline.directSocketsConstruct).not.toMatch(/^threw:ReferenceError/)
    // The reason string is platform-dependent for the same ReportBadMessage kill ('crashed' on
    // Windows); the oracle is that the renderer died at all.
    expect(['killed', 'crashed']).toContain(baseline.rendererGone)
    expect(guarded.directSockets).toEqual({
      tcp: 'undefined',
      udp: 'undefined',
      server: 'undefined'
    })
    expect(guarded.directSocketsConstruct).toBe('threw:ReferenceError')
    expect(guarded.rendererGone).toBe('none')
  }, 150_000)
})
