export const BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES = 256 * 1024
export const BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS = 10_000
export const BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS = 65_536
// Chromium's per-session socket pool; a lower cap refuses a heavy page's own connections.
export const BROWSER_NETWORK_TUNNEL_MAX_STREAMS = 256

export type BrowserNetworkTunnelFlowControl = {
  /** Largest stream window; streams start at the legacy window and grow within the connection window. */
  streamWindowBytes: number
  /** Bytes each side may have unacknowledged in flight across all streams; null is unbounded. */
  connectionWindow: { toClientBytes: number; toSessionBytes: number } | null
}

// Per-stream throughput is capped at window / RTT, so 256 KiB is ~2.9 MB/s over a 90 ms link.
export const BROWSER_NETWORK_TUNNEL_LEGACY_FLOW_CONTROL: BrowserNetworkTunnelFlowControl = {
  streamWindowBytes: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  connectionWindow: null
}

// Connection windows keep each sender's WebSocket queue far below its overflow cap (session 64 MiB,
// client 7 MiB) however many streams grow to the larger per-stream window.
export const BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL: BrowserNetworkTunnelFlowControl = {
  streamWindowBytes: 2 * 1024 * 1024,
  connectionWindow: { toClientBytes: 16 * 1024 * 1024, toSessionBytes: 4 * 1024 * 1024 }
}

// One chunk per KiB of window keeps tiny-frame floods bounded while a full window of 1 KiB frames fits.
export function browserNetworkTunnelMaxPendingChunks(windowBytes: number): number {
  return windowBytes / 1024
}

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
  windowBytes: number
  receiveWindowBytes: number
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
  flowControl?: BrowserNetworkTunnelFlowControl
  onClose?: () => void
  now?: () => number
  claimAggregateRetainedBytes?: (bytes: number) => (() => void) | null
}
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
