import { describe, expect, it, vi } from 'vitest'
import { testHostReachability, unreachableHostDetail } from './host-reachability'

describe('unreachableHostDetail', () => {
  it('points at Tailscale for tailnet CGNAT endpoints', () => {
    expect(unreachableHostDetail('ws://100.65.9.106:6768')).toBe(
      'Cannot reach 100.65.9.106:6768 — check Tailscale'
    )
  })

  it('points at Tailscale for MagicDNS endpoints', () => {
    expect(unreachableHostDetail('ws://my-desktop.tailnet-1234.ts.net:6768')).toBe(
      'Cannot reach my-desktop.tailnet-1234.ts.net:6768 — check Tailscale'
    )
  })

  it('stays generic for LAN endpoints', () => {
    expect(unreachableHostDetail('ws://192.168.1.50:6768')).toBe('Cannot reach 192.168.1.50:6768')
  })

  it('does not treat non-CGNAT 100.x addresses as Tailscale', () => {
    expect(unreachableHostDetail('ws://100.20.1.5:6768')).toBe('Cannot reach 100.20.1.5:6768')
  })
})

describe('testHostReachability', () => {
  it('returns false without leaving timers when WebSocket rejects a malformed endpoint', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new TypeError('Invalid URL')
        }
      }
    )

    try {
      await expect(testHostReachability('not-a-url')).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
