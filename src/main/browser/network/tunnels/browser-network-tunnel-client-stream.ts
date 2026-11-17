import { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import type { BrowserNetworkTunnelSourceFlowStream } from './browser-network-tunnel-source-flow'
import type { BrowserNetworkTunnelSourceReceiveStream } from './browser-network-tunnel-source-receive-flow'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_STREAMS
} from './browser-network-tunnel-stream-state'
import type { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'

export type BrowserNetworkTunnelClientStream = BrowserNetworkTunnelSourceFlowStream &
  BrowserNetworkTunnelSourceReceiveStream & {
    id: number
    socket: BrowserNetworkTunnelDuplex
    closed: boolean
    /** Writable (and its receive credit granted) before Opened: see BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES. */
    earlyData: boolean
    localEnded: boolean
    localHalfCloseSent: boolean
    remoteClosed: boolean
    connectTimeout: ReturnType<typeof setTimeout>
    resolveOpen: (socket: BrowserNetworkTunnelDuplex) => void
    rejectOpen: (error: Error) => void
  }

type BrowserNetworkTunnelClientStreamCallbacks = {
  writeBytes: (bytes: Uint8Array<ArrayBufferLike>, callback: (error?: Error | null) => void) => void
  requestRead: () => void
  consumeReadBytes: (bytes: number) => void
  finishWrite: (callback: (error?: Error | null) => void) => void
  destroyStream: (error: Error | null, callback: (error?: Error | null) => void) => void
  onConnectTimeout: (stream: BrowserNetworkTunnelClientStream) => void
}

export function createBrowserNetworkTunnelClientStream(
  id: number,
  windowBytes: number,
  earlyData: boolean,
  callbacks: BrowserNetworkTunnelClientStreamCallbacks
): { stream: BrowserNetworkTunnelClientStream; opening: Promise<BrowserNetworkTunnelDuplex> } {
  let resolveOpen = (_socket: BrowserNetworkTunnelDuplex): void => {}
  let rejectOpen = (_error: Error): void => {}
  const opening = new Promise<BrowserNetworkTunnelDuplex>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const socket = new BrowserNetworkTunnelDuplex(callbacks)
  const stream: BrowserNetworkTunnelClientStream = {
    id,
    socket,
    windowBytes,
    receiveWindowBytes: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    opened: false,
    closed: false,
    earlyData,
    localEnded: false,
    localHalfCloseSent: false,
    remoteEnded: false,
    remoteClosed: false,
    readableEnded: false,
    sendCredit: earlyData ? BROWSER_NETWORK_TUNNEL_EARLY_DATA_BYTES : 0,
    receiveCredit: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
    pendingToSocket: [],
    pendingToSocketBytes: 0,
    unsettledToSocket: [],
    readableDemand: false,
    pendingWrites: [],
    pendingWriteBytes: 0,
    connectTimeout: setTimeout(
      () => callbacks.onConnectTimeout(stream),
      BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
    ),
    resolveOpen,
    rejectOpen
  }
  return { stream, opening }
}

/** Throws why a new stream cannot open on this client, if it cannot. */
export function refuseBrowserNetworkTunnelClientOpen(
  closed: boolean,
  streamCount: number,
  streamIdsExhausted: boolean
): void {
  if (closed) {
    throw new Error('Browser tunnel is closed')
  }
  if (streamCount >= BROWSER_NETWORK_TUNNEL_MAX_STREAMS) {
    throw new Error('Browser tunnel stream limit exceeded')
  }
  if (streamIdsExhausted) {
    throw new Error('Browser tunnel stream id limit exceeded')
  }
}

/**
 * Early data: grants receive credit right behind Open (the response can follow Opened without
 * another round trip) and hands out the stream before the host connects it.
 */
export function startEarlyBrowserNetworkTunnelClientStream(
  stream: BrowserNetworkTunnelClientStream,
  frameSender: Pick<BrowserNetworkTunnelFrameSender, 'sendWindowUpdate'>,
  closeTunnel: (error: Error) => void
): void {
  if (!frameSender.sendWindowUpdate(stream.id, stream.receiveWindowBytes)) {
    closeTunnel(new Error('Browser tunnel transport rejected initial credit'))
  }
  stream.resolveOpen(stream.socket)
}
