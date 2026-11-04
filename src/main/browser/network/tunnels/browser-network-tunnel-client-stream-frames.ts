import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../../../shared/browser-network-tunnel-protocol'
import { dispatchBrowserNetworkTunnelClientFrame } from './browser-network-tunnel-client-frame-dispatch'
import type { BrowserNetworkTunnelClientStream } from './browser-network-tunnel-client-stream'
import {
  finishBrowserNetworkSourceData,
  queueBrowserNetworkSourceData
} from './browser-network-tunnel-source-receive-flow'

type BrowserNetworkTunnelClientStreamFrameActions = {
  /** Negotiated per-stream receive window for the initial grant and credit validation. */
  windowBytes: number
  send: (
    opcode: BrowserNetworkTunnelOpcode,
    streamId: number,
    payload?: Uint8Array<ArrayBufferLike>
  ) => boolean
  closeTunnel: (error: Error) => void
  flushWrites: (stream: BrowserNetworkTunnelClientStream) => void
  claimApplicationBytes: (bytes: number) => (() => void) | null
  retire: (stream: BrowserNetworkTunnelClientStream, error?: Error) => void
  fail: (stream: BrowserNetworkTunnelClientStream, error: Error) => void
}

export function handleBrowserNetworkTunnelClientStreamFrame(
  stream: BrowserNetworkTunnelClientStream,
  frame: BrowserNetworkTunnelFrame,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  dispatchBrowserNetworkTunnelClientFrame(frame, {
    opened: () => openedStream(stream, actions),
    grantCredit: () => grantStreamCredit(stream, frame.payload, actions),
    deliverData: () => deliverStreamData(stream, frame.payload, actions),
    halfClose: () => halfCloseStream(stream, actions.closeTunnel),
    close: () => closeStream(stream, actions),
    remoteFailure: (error) => actions.retire(stream, error),
    invalid: () =>
      actions.closeTunnel(new Error('Browser tunnel received an invalid stream transition'))
  })
}

/** Marks the stream open and grants the negotiated receive window, keeping tracked credit equal to the announcement. */
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
  // Track exactly what the grant announces, or in-window data would be rejected as a violation.
  stream.receiveCredit = actions.windowBytes
  if (
    !actions.send(
      BrowserNetworkTunnelOpcode.WindowUpdate,
      stream.id,
      encodeBrowserNetworkTunnelWindowUpdate(actions.windowBytes)
    )
  ) {
    actions.closeTunnel(new Error('Browser tunnel transport rejected initial credit'))
    return
  }
  stream.resolveOpen(stream.socket)
}

/** Applies peer send credit, fencing the tunnel if the total ever exceeds the negotiated window. */
function grantStreamCredit(
  stream: BrowserNetworkTunnelClientStream,
  payload: Uint8Array<ArrayBufferLike>,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  const credit = decodeBrowserNetworkTunnelWindowUpdate(payload)
  if (!stream.opened || !credit || stream.sendCredit + credit > actions.windowBytes) {
    actions.closeTunnel(new Error('Browser tunnel received invalid stream credit'))
    return
  }
  stream.sendCredit += credit
  actions.flushWrites(stream)
}

function deliverStreamData(
  stream: BrowserNetworkTunnelClientStream,
  payload: Uint8Array<ArrayBufferLike>,
  actions: BrowserNetworkTunnelClientStreamFrameActions
): void {
  const result = queueBrowserNetworkSourceData(stream, payload, actions.claimApplicationBytes)
  // Valid credit can exceed the shared memory budget, so exhaustion must only fail its stream.
  if (result === 'budget_exhausted') {
    actions.fail(stream, new Error('Browser tunnel receive buffer overflow'))
  } else if (result === 'invalid') {
    actions.closeTunnel(new Error('Browser tunnel received invalid destination data'))
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
