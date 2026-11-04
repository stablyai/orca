import { describe, expect, it } from 'vitest'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES,
  negotiateBrowserNetworkTunnelWindowBytes
} from './browser-network-tunnel-stream-state'

describe('negotiateBrowserNetworkTunnelWindowBytes', () => {
  it('falls back to the legacy window when the peer advertises nothing', () => {
    // A new side talking to an old peer must grant the legacy window, or the old peer rejects it.
    expect(negotiateBrowserNetworkTunnelWindowBytes(undefined)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
  })

  it('uses the shared maximum when both peers advertise the larger window', () => {
    expect(negotiateBrowserNetworkTunnelWindowBytes(BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES)).toBe(
      BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES
    )
  })

  it('caps a peer that advertises more than this build supports', () => {
    expect(
      negotiateBrowserNetworkTunnelWindowBytes(BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES * 4)
    ).toBe(BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES)
  })

  it('never drops below the legacy floor for a smaller or invalid advertisement', () => {
    expect(negotiateBrowserNetworkTunnelWindowBytes(1024)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
    expect(negotiateBrowserNetworkTunnelWindowBytes(Number.NaN)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
  })

  it('buffers at least a full negotiated window so in-window data is never rejected', () => {
    expect(BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES).toBeGreaterThanOrEqual(
      BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES
    )
  })
})
