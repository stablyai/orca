import { describe, expect, it } from 'vitest'
import { runBrowserRouteH3EgressProbe } from './browser-route-h3-egress-fixture'

describe('browser route HTTP/3 and Direct Sockets egress under Electron', () => {
  it('keeps every UDP egress path off the desktop and hides the renderer-killing constructors', async () => {
    const baseline = await runBrowserRouteH3EgressProbe(false)
    const guarded = await runBrowserRouteH3EgressProbe(true)

    expect(baseline.resolvedProxy).toBe('DIRECT')
    expect(guarded.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)

    expect(baseline.webTransportPackets).toBeGreaterThan(0)
    expect(guarded.webTransport).toMatch(/^rejected:/)
    expect(guarded.webTransportPackets).toBe(0)

    expect(baseline.forcedQuicPackets).toBeGreaterThan(0)
    expect(guarded.forcedQuicPackets).toBe(0)

    expect(baseline.directSockets).toEqual({ tcp: 'function', udp: 'function', server: 'function' })
    // ReportBadMessage may arrive after the constructor returns; renderer death is the signal.
    expect(baseline.directSocketsConstruct).not.toMatch(/^threw:ReferenceError/)
    // The same termination is reported as killed or crashed across platforms.
    expect(['killed', 'crashed']).toContain(baseline.rendererGone)
    expect(guarded.directSockets).toEqual({
      tcp: 'undefined',
      udp: 'undefined',
      server: 'undefined'
    })
    expect(guarded.directSocketsConstruct).toBe('threw:ReferenceError')
    expect(guarded.rendererGone).toBe('none')
  }, 90_000)
})
