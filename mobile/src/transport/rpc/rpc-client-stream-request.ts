import type { BrowserScreencastFrame } from '../../browser/browser-screencast-protocol'
import type { RpcEnvelopeFields, RpcRequestFrame } from './rpc-envelope-fields'
import type { ConnectionState } from '../connection/connection-state'

export type RpcStreamingListener = (result: unknown) => void

export type RpcStreamSubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  // Repeat these top-level fields on subscription replay and unsubscribe.
  envelope?: RpcEnvelopeFields
  // The owner decides when a new connection may re-send this stream (a page waits for its verdict).
  holdReplay?: RpcStreamReplayHold
}

// Asked when a new connection would re-send the stream; true means the owner calls resend once it may talk.
export type RpcStreamReplayHold = (resend: () => void) => boolean

export type StreamRequest = {
  method: string
  params: unknown
  envelope?: RpcEnvelopeFields
  listener?: RpcStreamingListener
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  holdReplay?: RpcStreamReplayHold
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
  receivedSnapshot?: boolean
}

export type StreamRegistryOptions = {
  nextId: () => string
  getState: () => ConnectionState
  sendFrame: (frame: RpcRequestFrame) => boolean
}
