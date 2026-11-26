import { describe, expect, it } from 'vitest'
import {
  BinaryChannelOpcode,
  decodeBinaryChannelFrame,
  encodeBinaryChannelFrame
} from '../../../../shared/remote-runtime/protocol/runtime-binary-channel'
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { RuntimeBinaryChannels } from './runtime-binary-channels'
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

function host() {
  const router = new RuntimeBinaryMessageRouter()
  const released: string[] = []
  const channels = new RuntimeBinaryChannels((connectionId) => {
    released.push(connectionId)
    router.deleteConnection(connectionId)
  })
  const receive = (bytes: Uint8Array): void => {
    if (!channels.route('socket', bytes, (id, payload) => router.dispatch(id, payload))) {
      router.dispatch('socket', bytes)
    }
  }
  return { router, channels, released, receive }
}

describe('runtime binary channels', () => {
  it('keeps each channel a connection of its own, both ways, until it closes', () => {
    const { router, channels, released, receive } = host()
    const sent: Uint8Array[] = []
    const a = channels.open('socket', 1, (bytes) => {
      sent.push(bytes)
    })
    const b = channels.open('socket', 2, (bytes) => {
      sent.push(bytes)
    })
    if ('error' in a || 'error' in b) {
      throw new Error('open failed')
    }
    // Two terminal multiplexes and a raw stream on one socket: the router alone refuses this mix.
    const seen: string[] = []
    router.registerTerminalStream(a.connectionId, 7, (f) => seen.push(`a:${f.payload.length}`))
    router.registerTerminalStream(b.connectionId, 7, (f) => seen.push(`b:${f.payload.length}`))
    const c = channels.open('socket', 3, () => true)
    if ('error' in c) {
      throw new Error('open failed')
    }
    router.registerRawMessage(c.connectionId, (bytes) => seen.push(`c:${bytes.length}`))

    receive(data(2, input(7, 'xx')))
    receive(data(1, input(7, 'x')))
    receive(data(3, new Uint8Array(5)))
    expect(seen).toEqual(['b:2', 'a:1', 'c:5'])

    a.sendBinary(input(7, 'out'))
    const outbound = decodeBinaryChannelFrame(sent[0])
    expect(outbound?.channel).toBe(1)
    expect(decodeTerminalStreamFrame(outbound!.payload)?.streamId).toBe(7)

    receive(encodeBinaryChannelFrame({ opcode: 2, channel: 1, payload: new Uint8Array() }))
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(released).toEqual([a.connectionId])
    expect(a.sendBinary(input(7, 'late'))).toBe(false)
    // A late frame for the closed channel is dropped, never handed to another stream.
    receive(data(1, input(7, 'late')))
    expect(seen).toEqual(['b:2', 'a:1', 'c:5'])

    channels.closeSocket('socket')
    expect(released).toEqual([a.connectionId, b.connectionId, c.connectionId])
    expect(b.signal.aborted && c.signal.aborted).toBe(true)
  })

  it('leaves sockets that never opened a channel on their own handlers', () => {
    const { router, receive } = host()
    const raw: number[] = []
    router.registerRawMessage('socket', (bytes) => raw.push(bytes[0]))
    // Even a frame that looks like a channel frame is the raw stream's data on such a socket.
    receive(data(1, new Uint8Array(1)))
    expect(raw).toEqual([0x6d])
  })

  it('refuses a channel already open, and decodes only well-formed frames', () => {
    const { channels } = host()
    expect('error' in channels.open('socket', 1, () => true)).toBe(false)
    expect(channels.open('socket', 1, () => true)).toEqual({
      error: 'Binary channel is already open.'
    })
    const frame = data(0xffffffff, Uint8Array.of(1, 2, 3))
    expect(decodeBinaryChannelFrame(frame)).toEqual({
      opcode: BinaryChannelOpcode.Data,
      channel: 0xffffffff,
      payload: Uint8Array.of(1, 2, 3)
    })
    expect(decodeBinaryChannelFrame(data(0, new Uint8Array()))).toBeNull()
    expect(decodeBinaryChannelFrame(input(1, 'x'))).toBeNull()
    expect(decodeBinaryChannelFrame(frame.subarray(0, 7))).toBeNull()
  })
})
