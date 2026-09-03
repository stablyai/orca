import { describe, expect, it } from 'vitest'
import { browserRouteWebrtcEgressElectronMain } from './browser-route-webrtc-egress-electron-main'

// Why a source-order assertion: the accounting this probe depends on is an *ordering* in the
// emitted child, and no probe run can observe it — a watchdog armed at evaluation only differs
// from one armed after readiness when startup is slow, which is exactly the contended runner
// this file cannot reproduce. Reverting the arm to evaluation time reddens nothing otherwise.
describe('browser route WebRTC egress probe child', () => {
  const source = browserRouteWebrtcEgressElectronMain()

  it('arms the budget after the app is ready, so cold start is not charged against it', () => {
    const readyAt = source.indexOf('await app.whenReady()')
    // The budget's own closing argument, not a bare `setTimeout(` — the ICE script the probe
    // injects into the guest carries one of those and it precedes readiness by design.
    const armedAt = source.indexOf('}, 20000)')

    // Both markers must exist, or the ordering assertion below passes vacuously.
    expect(readyAt).toBeGreaterThanOrEqual(0)
    expect(armedAt).toBeGreaterThanOrEqual(0)
    expect(readyAt).toBeLessThan(armedAt)
  })

  it('keeps the probe budget at 20s and disarms it before the result is written', () => {
    expect(source).toContain('}, 20000)')

    const disarmedAt = source.indexOf('clearTimeout(timeout)')
    const writtenAt = source.indexOf('writeFileSync(config.resultPath, JSON.stringify(result))')

    expect(disarmedAt).toBeGreaterThanOrEqual(0)
    expect(writtenAt).toBeGreaterThanOrEqual(0)
    expect(disarmedAt).toBeLessThan(writtenAt)
  })
})
