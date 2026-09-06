import { describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'

const BUILD_A = 'a'.repeat(64)
const BUILD_B = 'b'.repeat(64)

describe('mobile web diagnostics store', () => {
  it('records only bounded package, health, and recovery state per host', () => {
    const store = new MobileWebDiagnosticsStore()

    store.begin('host-a')
    store.sessionReady('host-a', BUILD_A, 'verified-cache', 148.4)
    store.refreshSucceeded('host-a', 972.6)
    store.healthy('host-a', BUILD_A)
    store.restarted('host-a', BUILD_A)
    store.recovered('host-a', BUILD_B, 'webview_crash_loop')

    expect(store.get('host-a')).toEqual({
      bridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      buildId: BUILD_B,
      packageSource: 'verified-cache',
      packageStatus: 'warning',
      activationMs: 148,
      refreshMs: 973,
      healthStatus: 'recovered',
      recoveryCount: 1,
      terminalResyncCount: 0,
      terminalOverflowCount: 0,
      terminalAckLagMaxMs: null,
      terminalOutstandingBytesHighWater: 0,
      terminalLastResyncReason: null,
      lastFailureCode: 'webview_crash_loop'
    })
    expect(store.get('host-b').buildId).toBeNull()
  })

  it('drops untrusted build and failure strings from diagnostic snapshots', () => {
    const store = new MobileWebDiagnosticsStore()

    store.begin('host-a')
    store.sessionReady('host-a', '/private/cache/session', 'desktop-refresh')
    store.warning('host-a', '/private/cache denied')

    expect(store.get('host-a')).toMatchObject({
      buildId: null,
      packageStatus: 'unavailable',
      activationMs: null,
      lastFailureCode: 'unknown'
    })
  })

  it('drops invalid or unbounded timing values', () => {
    const store = new MobileWebDiagnosticsStore()

    store.begin('host-a')
    store.sessionReady('host-a', BUILD_A, 'verified-cache', 120_001)
    store.refreshSucceeded('host-a', Number.NaN)

    expect(store.get('host-a')).toMatchObject({
      activationMs: null,
      refreshMs: null
    })
  })

  it('counts only bounded terminal resync diagnostics', () => {
    const store = new MobileWebDiagnosticsStore()

    store.begin('host-a')
    store.terminalResync('host-a', 'gap')
    store.terminalResync('host-a', 'snapshot-invalid')
    store.terminalResync('host-a', 'flow-overflow')

    expect(store.get('host-a')).toMatchObject({
      terminalResyncCount: 3,
      terminalOverflowCount: 1,
      terminalLastResyncReason: 'flow-overflow'
    })
  })

  it('retains bounded terminal flow high-water values without stream identity', () => {
    const store = new MobileWebDiagnosticsStore()

    store.begin('host-a')
    store.terminalFlow('host-a', { ackLagMs: 42.4, outstandingBytes: 65_536 })
    store.terminalFlow('host-a', { ackLagMs: 18, outstandingBytes: 4_096 })
    store.terminalFlow('host-a', { ackLagMs: 120_001, outstandingBytes: 256 * 1024 + 1 })

    expect(store.get('host-a')).toMatchObject({
      terminalAckLagMaxMs: 42,
      terminalOutstandingBytesHighWater: 65_536
    })
    expect(JSON.stringify(store.get('host-a'))).not.toContain('stream')
  })

  it('publishes stable snapshots to native diagnostic subscribers', () => {
    const store = new MobileWebDiagnosticsStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.begin('host-a')
    const first = store.get('host-a')
    expect(store.get('host-a')).toBe(first)
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    store.refreshSucceeded('host-a')
    expect(listener).toHaveBeenCalledOnce()
  })
})
