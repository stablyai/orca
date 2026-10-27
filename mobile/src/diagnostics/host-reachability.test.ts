import { describe, expect, it, vi } from 'vitest'
import { formatEndpoint, testHostReachability, unreachableHostDetail } from './host-reachability'

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

  it('does not echo malformed endpoints that may contain credentials', () => {
    expect(formatEndpoint('not-a-url?token=secret')).toBe('invalid endpoint')
  })
})

describe('testHostReachability', () => {
  it.each(['wss://orca.example', 'ws://192.168.1.10:6768'])(
    'uses edge headers only for secure probes to %s',
    async (endpoint) => {
      const calls: unknown[][] = []
      const sockets: ProbeSocket[] = []
      class ProbeSocket {
        onopen: (() => void) | null = null
        onerror: (() => void) | null = null
        close = vi.fn()
        constructor(...args: unknown[]) {
          calls.push(args)
          sockets.push(this)
        }
      }
      vi.stubGlobal('WebSocket', ProbeSocket)
      try {
        const headers = { 'X-Token': 'synthetic-secret' }
        const result = testHostReachability(endpoint, headers)
        expect(calls).toEqual([
          endpoint.startsWith('wss://')
            ? [endpoint, undefined, { headers, followRedirects: false }]
            : [endpoint]
        ])
        const socket = sockets[0]
        socket?.onopen?.()
        await expect(result).resolves.toBe(true)
        expect(socket?.close).toHaveBeenCalledOnce()
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

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
