import {
  BinaryChannelOpcode,
  decodeBinaryChannelFrame,
  encodeBinaryChannelFrame,
  isBinaryChannelKind,
  MAX_HOST_CHANNEL_PAYLOAD_BYTES,
  MAX_OPEN_BINARY_CHANNELS
} from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import type { RpcBinarySender } from '../transports/rpc-binary-sender'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { RuntimeClientCapabilities } from '../callers/runtime-client-capabilities'

type OpenChannel = {
  connectionId: string
  abort: AbortController
  capabilities: RuntimeClientCapabilities
}

export type OpenedBinaryChannel = {
  /** The stream's own connection id: its binary handlers and cleanups live under it. */
  connectionId: string
  /** Aborts when the client closes the channel or the socket closes. */
  signal: AbortSignal
  sendBinary: RpcBinarySender
  /** What the stream's own socket would have declared, set by the request that opened it. */
  capabilities: RuntimeClientCapabilities
  /** Releases the channel if this request opened it; a request that joined it leaves it open. */
  release: () => void
}

/**
 * The binary channels open on each socket (see `runtime-binary-channel.ts`). Each channel is a
 * connection of its own to everything below it: closing it releases what its stream registered,
 * exactly as closing that stream's own socket did.
 */
export class RuntimeBinaryChannels {
  private readonly bySocket = new Map<string, Map<number, OpenChannel>>()

  constructor(private readonly releaseConnection: (connectionId: string) => void) {}

  /**
   * The channel's connection, opened by its first request and released when a reply ends that
   * request's stream (see `dispatchForDevice`), the client closes it, or the socket closes. Later requests
   * naming an open channel (a stream's own calls) run under the same connection, as they did on
   * that stream's own socket.
   */
  open(
    socketConnectionId: string,
    channel: number,
    sendBinary: RpcBinarySender,
    capabilities: readonly RuntimeCapability[]
  ): OpenedBinaryChannel | { error: string } {
    let channels = this.bySocket.get(socketConnectionId)
    let current = channels?.get(channel)
    const opener = !current
    if (!current) {
      if ((channels?.size ?? 0) >= MAX_OPEN_BINARY_CHANNELS) {
        return { error: 'Too many binary channels are open on this connection.' }
      }
      if (!channels) {
        channels = new Map()
        this.bySocket.set(socketConnectionId, channels)
      }
      current = {
        connectionId: `${socketConnectionId}#${channel}`,
        abort: new AbortController(),
        capabilities: new RuntimeClientCapabilities()
      }
      current.capabilities.replace(capabilities)
      channels.set(channel, current)
    }
    const table = channels!
    const open = current
    return {
      connectionId: open.connectionId,
      signal: open.abort.signal,
      capabilities: open.capabilities,
      sendBinary: (bytes, options) =>
        table.get(channel) === open && bytes.byteLength <= MAX_HOST_CHANNEL_PAYLOAD_BYTES
          ? sendBinary(
              encodeBinaryChannelFrame({
                opcode: BinaryChannelOpcode.Data,
                channel,
                payload: bytes
              }),
              options
            )
          : false,
      release: () => {
        if (opener && table.get(channel) === open) {
          this.close(socketConnectionId, channel)
        }
      }
    }
  }

  /**
   * Hands a channel frame's payload to its channel's connection. False for a socket that never
   * opened a channel, or bytes that aren't channel frames: the socket's own handlers take those.
   * On a socket that uses channels, a channel frame is never handed to the socket itself: a late
   * one (its channel released) or a malformed one is dropped.
   */
  route(
    socketConnectionId: string,
    bytes: Uint8Array<ArrayBufferLike>,
    deliver: (connectionId: string, payload: Uint8Array<ArrayBufferLike>) => void
  ): boolean {
    const channels = this.bySocket.get(socketConnectionId)
    if (!channels || !isBinaryChannelKind(bytes)) {
      return false
    }
    const frame = decodeBinaryChannelFrame(bytes)
    if (!frame) {
      return true
    }
    if (frame.opcode === BinaryChannelOpcode.Close) {
      this.close(socketConnectionId, frame.channel)
      return true
    }
    const open = channels.get(frame.channel)
    if (open) {
      deliver(open.connectionId, frame.payload)
    }
    return true
  }

  close(socketConnectionId: string, channel: number): void {
    const channels = this.bySocket.get(socketConnectionId)
    const open = channels?.get(channel)
    if (!channels || !open) {
      return
    }
    // The socket keeps its (possibly empty) table until it closes, so its late frames stay dropped.
    channels.delete(channel)
    this.release(open)
  }

  closeSocket(socketConnectionId: string): void {
    const channels = this.bySocket.get(socketConnectionId)
    if (!channels) {
      return
    }
    this.bySocket.delete(socketConnectionId)
    for (const open of channels.values()) {
      this.release(open)
    }
  }

  // One channel's failing cleanup must not stop its siblings' or the socket's.
  private release(open: OpenChannel): void {
    try {
      open.abort.abort()
    } catch (error) {
      console.error('[runtime] A binary channel stream failed to stop:', error)
    }
    try {
      this.releaseConnection(open.connectionId)
    } catch (error) {
      console.error('[runtime] A binary channel failed to release its stream:', error)
    }
  }
}
