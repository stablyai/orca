import {
  BinaryChannelOpcode,
  decodeBinaryChannelFrame,
  encodeBinaryChannelFrame,
  MAX_OPEN_BINARY_CHANNELS
} from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import type { RpcBinarySender } from '../transports/rpc-binary-sender'

type OpenChannel = { connectionId: string; abort: AbortController }

export type OpenedBinaryChannel = {
  /** The stream's own connection id: its binary handlers and cleanups live under it. */
  connectionId: string
  /** Aborts when the client closes the channel or the socket closes. */
  signal: AbortSignal
  sendBinary: RpcBinarySender
}

/**
 * The binary channels open on each socket (see `runtime-binary-channel.ts`). Each channel is a
 * connection of its own to everything below it: closing it releases what its stream registered,
 * exactly as closing that stream's own socket did.
 */
export class RuntimeBinaryChannels {
  private readonly bySocket = new Map<string, Map<number, OpenChannel>>()

  constructor(private readonly releaseConnection: (connectionId: string) => void) {}

  open(
    socketConnectionId: string,
    channel: number,
    sendBinary: RpcBinarySender
  ): OpenedBinaryChannel | { error: string } {
    let channels = this.bySocket.get(socketConnectionId)
    if (channels?.has(channel)) {
      return { error: 'Binary channel is already open.' }
    }
    if ((channels?.size ?? 0) >= MAX_OPEN_BINARY_CHANNELS) {
      return { error: 'Too many binary channels are open on this connection.' }
    }
    if (!channels) {
      channels = new Map()
      this.bySocket.set(socketConnectionId, channels)
    }
    const opened = {
      connectionId: `${socketConnectionId}#${channel}`,
      abort: new AbortController()
    }
    channels.set(channel, opened)
    return {
      connectionId: opened.connectionId,
      signal: opened.abort.signal,
      sendBinary: (bytes, options) =>
        channels.get(channel) === opened
          ? sendBinary(
              encodeBinaryChannelFrame({
                opcode: BinaryChannelOpcode.Data,
                channel,
                payload: bytes
              }),
              options
            )
          : false
    }
  }

  /**
   * Hands a channel frame's payload to its channel's connection. False for a socket that never
   * opened a channel, or bytes that aren't a channel frame: the socket's own handlers take those.
   */
  route(
    socketConnectionId: string,
    bytes: Uint8Array<ArrayBufferLike>,
    deliver: (connectionId: string, payload: Uint8Array<ArrayBufferLike>) => void
  ): boolean {
    const channels = this.bySocket.get(socketConnectionId)
    if (!channels) {
      return false
    }
    const frame = decodeBinaryChannelFrame(bytes)
    if (!frame) {
      return false
    }
    if (frame.opcode === BinaryChannelOpcode.Close) {
      this.close(socketConnectionId, frame.channel)
      return true
    }
    // A frame for a channel already released is late, not misrouted: drop it.
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
    channels.delete(channel)
    if (channels.size === 0) {
      this.bySocket.delete(socketConnectionId)
    }
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

  private release(open: OpenChannel): void {
    open.abort.abort()
    this.releaseConnection(open.connectionId)
  }
}
