import { describe, expect, it, vi } from 'vitest'
import {
  BinaryChannelOpcode,
  decodeBinaryChannelFrame,
  encodeBinaryChannelFrame,
  MAX_HOST_CHANNEL_PAYLOAD_BYTES,
  MAX_OPEN_BINARY_CHANNELS
} from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { RuntimeBinaryChannels, type OpenedBinaryChannel } from './runtime-binary-channels'
import { RuntimeBinaryMessageRouter } from './runtime-binary-message-router'

const input = (streamId: number, text: string): Uint8Array =>
  encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Input,
    streamId,
    seq: 1,
    payload: new TextEncoder().encode(text)
  })

const data = (channel: number, payload: Uint8Array): Uint8Array =>
  encodeBinaryChannelFrame({ opcode: BinaryChannelOpcode.Data, channel, payload })
const closeFrame = (channel: number): Uint8Array =>
  encodeBinaryChannelFrame({
    opcode: BinaryChannelOpcode.Close,
    channel,
    payload: new Uint8Array()
  })

function host(releaseConnection?: (connectionId: string) => void) {
  const router = new RuntimeBinaryMessageRouter()
  const released: string[] = []
  const channels = new RuntimeBinaryChannels((connectionId) => {
    released.push(connectionId)
    router.deleteConnection(connectionId)
    releaseConnection?.(connectionId)
  })
  const receive = (bytes: Uint8Array): void => {
    if (!channels.route('socket', bytes, (id, payload) => router.dispatch(id, payload))) {
      router.dispatch('socket', bytes)
    }
  }
  const open = (channel: number, send: OpenedBinaryChannel['sendBinary'] = () => true) => {
    const opened = channels.open('socket', channel, send, [])
    if ('error' in opened) {
      throw new Error(opened.error)
    }
    return opened
  }
  return { router, channels, released, receive, open }
}

describe('runtime binary channels', () => {
  it('keeps each channel a connection of its own, both ways, until it closes', () => {
    const { router, channels, released, receive, open } = host()
    const sent: Uint8Array[] = []
    const a = open(1, (bytes) => {
      sent.push(bytes)
    })
    const b = open(2)
    // Two terminal multiplexes and a raw stream on one socket: the router alone refuses this mix.
    const seen: string[] = []
    router.registerTerminalStream(a.connectionId, 7, (f) => seen.push(`a:${f.payload.length}`))
    router.registerTerminalStream(b.connectionId, 7, (f) => seen.push(`b:${f.payload.length}`))
    const c = open(3)
    router.registerRawMessage(c.connectionId, (bytes) => seen.push(`c:${bytes.length}`))

    receive(data(2, input(7, 'xx')))
    receive(data(1, input(7, 'x')))
    receive(data(3, new Uint8Array(5)))
    expect(seen).toEqual(['b:2', 'a:1', 'c:5'])

    a.sendBinary(input(7, 'out'))
    const outbound = decodeBinaryChannelFrame(sent[0])
    expect(outbound?.channel).toBe(1)
    expect(decodeTerminalStreamFrame(outbound!.payload)?.streamId).toBe(7)

    receive(closeFrame(1))
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(released).toEqual([a.connectionId])
    expect(a.sendBinary(input(7, 'late'))).toBe(false)
    receive(data(1, input(7, 'late')))
    expect(seen).toEqual(['b:2', 'a:1', 'c:5'])

    channels.closeSocket('socket')
    expect(released).toEqual([a.connectionId, b.connectionId, c.connectionId])
    expect(b.signal.aborted && c.signal.aborted).toBe(true)
  })

  it('drops late and malformed channel frames even after its last channel closed', () => {
    const { router, receive, open } = host()
    const raw: number[] = []
    router.registerRawMessage('socket', (bytes) => raw.push(bytes.length))
    open(1).release()
    receive(data(1, new Uint8Array(3)))
    const malformed = [
      Uint8Array.of(0x6d, 2, 1, 0, 1, 0, 0, 0),
      Uint8Array.of(0x6d, 1, 3, 0, 1, 0, 0, 0),
      Uint8Array.of(0x6d, 1, 1, 0, 0, 0, 0, 0),
      Uint8Array.of(0x6d, 1, 1, 7, 1, 0, 0, 0),
      Uint8Array.of(0x6d, 1, 1)
    ]
    for (const frame of malformed) {
      receive(frame)
    }
    expect(raw).toEqual([])
    // Frames that aren't channel frames still reach the socket's own handler.
    receive(Uint8Array.of(1, 2))
    expect(raw).toEqual([2])
  })

  it('leaves sockets that never opened a channel on their own handlers', () => {
    const { router, receive } = host()
    const raw: number[] = []
    router.registerRawMessage('socket', (bytes) => raw.push(bytes[0]))
    receive(data(1, new Uint8Array(1)))
    expect(raw).toEqual([0x6d])
  })

  it('caps open channels, frees a slot on release, and lets calls join an open channel', () => {
    const { channels, open } = host()
    const first = open(1)
    const call = open(1)
    expect(call.connectionId).toBe(first.connectionId)
    // A joined request ending leaves the channel to the stream that opened it.
    call.release()
    expect(first.signal.aborted).toBe(false)
    for (let channel = 2; channel <= MAX_OPEN_BINARY_CHANNELS; channel += 1) {
      open(channel)
    }
    expect(channels.open('socket', MAX_OPEN_BINARY_CHANNELS + 1, () => true, [])).toEqual({
      error: 'Too many binary channels are open on this connection.'
    })
    first.release()
    expect(first.signal.aborted).toBe(true)
    expect('error' in channels.open('socket', MAX_OPEN_BINARY_CHANNELS + 1, () => true, [])).toBe(
      false
    )
  })

  it('releases every channel on socket close even when one cleanup throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { channels, released, open } = host((connectionId) => {
      if (connectionId.endsWith('#1')) {
        throw new Error('cleanup failed')
      }
    })
    const a = open(1)
    const b = open(2)
    channels.closeSocket('socket')
    expect(released).toEqual([a.connectionId, b.connectionId])
    expect(b.signal.aborted).toBe(true)
    errors.mockRestore()
  })

  it('never sends a frame that, sealed, would exceed the client frame limit', () => {
    const { open } = host()
    const sent: number[] = []
    const channel = open(1, (bytes) => {
      sent.push(bytes.byteLength)
    })
    expect(channel.sendBinary(new Uint8Array(8 * 1024 * 1024 - 8))).toBe(false)
    channel.sendBinary(new Uint8Array(MAX_HOST_CHANNEL_PAYLOAD_BYTES))
    expect(sent).toHaveLength(1)
    // E2EE v2 seals a binary frame with 82 bytes; the client takes up to 8 MiB + 64.
    expect(sent[0] + 82).toBeLessThanOrEqual(8 * 1024 * 1024 + 64)
  })

  it('encodes only valid channel numbers and decodes only well-formed frames', () => {
    const frame = data(0xffffffff, Uint8Array.of(1, 2, 3))
    expect(decodeBinaryChannelFrame(frame)).toEqual({
      opcode: BinaryChannelOpcode.Data,
      channel: 0xffffffff,
      payload: Uint8Array.of(1, 2, 3)
    })
    expect(() => data(0, new Uint8Array())).toThrow(RangeError)
    expect(decodeBinaryChannelFrame(input(1, 'x'))).toBeNull()
    expect(decodeBinaryChannelFrame(frame.subarray(0, 7))).toBeNull()
  })
})
