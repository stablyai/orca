import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import type { RpcEnvelopeFields, RpcRequestFrame } from './rpc-envelope-fields'
import type { ConnectionState } from './types'

export type StreamRequest = {
  method: string
  params: unknown
  envelope?: RpcEnvelopeFields
  listener?: RpcStreamingListener
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
  receivedSnapshot?: boolean
}

export type StreamRegistryOptions = {
  nextId: () => string
  getState: () => ConnectionState
  sendFrame: (frame: RpcRequestFrame) => boolean
  sendBinary?: (bytes: Uint8Array) => boolean
}
export type RpcStreamingListener = (result: unknown) => unknown

export type RpcStreamSubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  envelope?: RpcEnvelopeFields
}
