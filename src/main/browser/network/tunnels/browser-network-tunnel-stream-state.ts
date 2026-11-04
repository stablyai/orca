// Legacy per-stream flow-control window. It also caps per-stream throughput to window/RTT:
// invisible on a LAN, but a hard ceiling on a high-latency paired link (e.g. ~2.9 MB/s at 90ms).
// Peers that advertise support negotiate up to BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES instead;
// this value stays the floor and the default when either side does not advertise.
export const BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES = 256 * 1024
// Largest window two advertising peers negotiate. Raises the high-RTT ceiling ~8x; bounds the
// retained buffers and outbound memory a single stream can pin.
export const BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES = 2 * 1024 * 1024
export const BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS = 10_000
// Must cover the largest negotiated window, or in-window data would be rejected as overflow.
export const BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_BYTES =
  BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES
// Covers the largest negotiated window at 1 KiB frames — the same pairing the legacy 256-chunk
// cap had with the 256 KiB window. Tinier frames still trip it, keeping the flood bound.
export const BROWSER_NETWORK_TUNNEL_MAX_PENDING_SOCKET_CHUNKS =
  BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES / 1024

/** The effective window is each side's own maximum capped by what the peer advertises (legacy floor). */
export function negotiateBrowserNetworkTunnelWindowBytes(
  peerMaxWindowBytes: number | undefined
): number {
  if (
    typeof peerMaxWindowBytes !== 'number' ||
    !Number.isSafeInteger(peerMaxWindowBytes) ||
    peerMaxWindowBytes < BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
  ) {
    return BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
  }
  return Math.min(BROWSER_NETWORK_TUNNEL_MAX_WINDOW_BYTES, peerMaxWindowBytes)
}
export const BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS = 65_536
// Chromium's per-session socket pool; a lower cap refuses a heavy page's own connections.
export const BROWSER_NETWORK_TUNNEL_MAX_STREAMS = 256

export function validateBrowserNetworkTunnelGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 1 || generation > 0xffff_ffff) {
    throw new Error('Browser tunnel generation is invalid')
  }
}

export function reserveBrowserNetworkTunnelStreamId(
  openedStreamIds: Set<number>,
  streamId: number
): 'stream_id_reused' | 'stream_id_budget_exhausted' | null {
  if (openedStreamIds.has(streamId)) {
    return 'stream_id_reused'
  }
  if (openedStreamIds.size >= BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS) {
    return 'stream_id_budget_exhausted'
  }
  openedStreamIds.add(streamId)
  return null
}

export type BrowserNetworkTunnelSocket = {
  destroyed: boolean
  setNoDelay(noDelay?: boolean): BrowserNetworkTunnelSocket
  pause(): BrowserNetworkTunnelSocket
  resume(): BrowserNetworkTunnelSocket
  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean
  end(): BrowserNetworkTunnelSocket
  destroy(): BrowserNetworkTunnelSocket
  on(event: 'connect', listener: () => void): BrowserNetworkTunnelSocket
  on(
    event: 'data',
    listener: (bytes: Uint8Array<ArrayBufferLike>) => void
  ): BrowserNetworkTunnelSocket
  on(event: 'end' | 'close', listener: () => void): BrowserNetworkTunnelSocket
  on(event: 'error', listener: (error: Error) => void): BrowserNetworkTunnelSocket
}

export type BrowserNetworkTunnelStream = {
  id: number
  socket: BrowserNetworkTunnelSocket
  connected: boolean
  closed: boolean
  receiveCredit: number
  sendCredit: number
  pendingToClient: Uint8Array<ArrayBufferLike>[]
  pendingToClientBytes: number
  pendingDestinationWriteReleases: Set<() => void>
  clientEnded: boolean
  destinationEnded: boolean
  destinationClosed: boolean
  destinationHalfCloseSent: boolean
  connectTimeout: ReturnType<typeof setTimeout>
}

export type BrowserNetworkTunnelSessionOptions = {
  tunnelGeneration: number
  connect: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  /** Negotiated per-stream receive window; defaults to the legacy window. */
  receiveWindowBytes?: number
  onClose?: () => void
  now?: () => number
  claimAggregateRetainedBytes?: (bytes: number) => (() => void) | null
}
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser-network-tunnel-protocol'
