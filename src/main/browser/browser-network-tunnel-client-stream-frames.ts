import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import { dispatchBrowserNetworkTunnelClientFrame } from './browser-network-tunnel-client-frame-dispatch'
import type { BrowserNetworkTunnelClientStream } from './browser-network-tunnel-client-stream'
import {
  finishBrowserNetworkSourceData,
  queueBrowserNetworkSourceData
} from './browser-network-tunnel-source-receive-flow'
import { BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES } from './browser-network-tunnel-stream-state'

type BrowserNetworkTunnelClientStreamFrameActions = {
  send: (
    opcode: BrowserNetworkTunnelOpcode,
    streamId: number,
    payload?: Uint8Array<ArrayBufferLike>
  ) => boolean
  closeTunnel: (error: Error) => void
  flushWrites: (stream: BrowserNetworkTunnelClientStream) => void
  claimApplicationBytes: (bytes: number) => (() => void) | null
  retire: (stream: BrowserNetworkTunnelClientStream, error?: Error) => void
}

export function handleBrowserNetworkTunnelClientStreamFrame(
  stream: BrowserNetworkTunnelClientStream,
  frame: BrowserNetworkTunnelFrame,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  dispatchBrowserNetworkTunnelClientFrame(frame, {
    opened: () => openedStream(stream, actions),
    grantCredit: () => grantStreamCredit(stream, frame.payload, actions),
    deliverData: () =>
      deliverStreamData(stream, frame.payload, actions.claimApplicationBytes, actions.closeTunnel),
    halfClose: () => halfCloseStream(stream, actions.closeTunnel),
    close: () => closeStream(stream, actions),
    remoteFailure: (error) => actions.retire(stream, error),
    invalid: () =>
      actions.closeTunnel(new Error('Browser tunnel received an invalid stream transition'))
  })
}

function openedStream(
  stream: BrowserNetworkTunnelClientStream,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  if (stream.opened) {
    actions.closeTunnel(new Error('Browser tunnel received a duplicate opened frame'))
    return
  }
  stream.opened = true
  clearTimeout(stream.connectTimeout)
  if (
    !actions.send(
      BrowserNetworkTunnelOpcode.WindowUpdate,
      stream.id,
      encodeBrowserNetworkTunnelWindowUpdate(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
    )
  ) {
    actions.closeTunnel(new Error('Browser tunnel transport rejected initial credit'))
    return
  }
  stream.resolveOpen(stream.socket)
}

function grantStreamCredit(
  stream: BrowserNetworkTunnelClientStream,
  payload: Uint8Array<ArrayBufferLike>,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  const credit = decodeBrowserNetworkTunnelWindowUpdate(payload)
  if (
    !stream.opened ||
    !credit ||
    stream.sendCredit + credit > BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
  ) {
    actions.closeTunnel(new Error('Browser tunnel received invalid stream credit'))
    return
  }
  stream.sendCredit += credit
  actions.flushWrites(stream)
}

function deliverStreamData(
  stream: BrowserNetworkTunnelClientStream,
  payload: Uint8Array<ArrayBufferLike>,
  claimApplicationBytes: (bytes: number) => (() => void) | null,
  closeTunnel: (error: Error) => void
): void {
  if (!queueBrowserNetworkSourceData(stream, payload, claimApplicationBytes)) {
    closeTunnel(new Error('Browser tunnel received invalid destination data'))
  }
}

function halfCloseStream(
  stream: BrowserNetworkTunnelClientStream,
  closeTunnel: (error: Error) => void
): void {
  if (!stream.opened || !finishBrowserNetworkSourceData(stream)) {
    closeTunnel(new Error('Browser tunnel received an invalid destination half-close'))
  }
}

function closeStream(
  stream: BrowserNetworkTunnelClientStream,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  if (!stream.opened || stream.remoteClosed) {
    actions.closeTunnel(new Error('Browser tunnel received an invalid destination close'))
    return
  }
  stream.remoteClosed = true
  stream.localEnded = true
  stream.socket.once('end', () => actions.retire(stream))
  if (!stream.remoteEnded) {
    finishBrowserNetworkSourceData(stream)
  }
  stream.socket.end()
}
