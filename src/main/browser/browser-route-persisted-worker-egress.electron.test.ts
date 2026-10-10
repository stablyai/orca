import { describe, expect, it } from 'vitest'
import { runPersistedWorkerProbe } from './browser-route-persisted-worker-fixture'

describe('browser route persisted-worker egress under Electron', () => {
  it('routes a forced worker wake once proxy setup has started', async () => {
    const baseline = await runPersistedWorkerProbe(false)
    const protectedSession = await runPersistedWorkerProbe(true)

    expect(baseline.preProxyWorkerRequests).toBeGreaterThan(0)
    expect(baseline.workerRunningBeforeForcedWake).toBe(false)
    expect(protectedSession.workerRunningBeforeForcedWake).toBe(false)
    expect(baseline.directWorkerStartRequests).toBeGreaterThan(0)
    expect(baseline.socksWorkerStartRequests).toBe(0)
    expect(baseline.directWorkerAfterProxyRequests).toBe(0)
    expect(baseline.socksWorkerAfterProxyRequests).toBeGreaterThan(0)
    expect(protectedSession.directWorkerStartRequests).toBe(0)
    expect(protectedSession.directWorkerAfterProxyRequests).toBe(0)
    expect(protectedSession.socksWorkerStartRequests).toBeGreaterThan(0)
    expect(protectedSession.socksWorkerAfterProxyRequests).toBeGreaterThan(0)
    expect(protectedSession.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)
    expect(protectedSession.postProxyWorkerRequests).toBeGreaterThan(0)
  }, 180_000)
})
