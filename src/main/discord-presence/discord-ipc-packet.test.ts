import { describe, expect, it } from 'vitest'
import {
  DISCORD_IPC_OPCODE,
  DiscordIpcPacketDecoder,
  encodeDiscordIpcPacket
} from './discord-ipc-packet'

describe('discord ipc packets', () => {
  it('encodes a little-endian opcode and length header before the JSON body', () => {
    const packet = encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.handshake, { v: 1, client_id: '1' })
    const body = JSON.stringify({ v: 1, client_id: '1' })
    expect(packet.readUInt32LE(0)).toBe(0)
    expect(packet.readUInt32LE(4)).toBe(Buffer.byteLength(body))
    expect(packet.subarray(8).toString('utf8')).toBe(body)
  })

  it('reassembles a packet split across chunks', () => {
    const packet = encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.frame, { evt: 'READY' })
    const decoder = new DiscordIpcPacketDecoder()
    expect(decoder.push(packet.subarray(0, 5))).toEqual([])
    expect(decoder.push(packet.subarray(5, 12))).toEqual([])
    expect(decoder.push(packet.subarray(12))).toEqual([
      { op: DISCORD_IPC_OPCODE.frame, payload: { evt: 'READY' } }
    ])
  })

  it('splits several packets delivered in one chunk', () => {
    const decoder = new DiscordIpcPacketDecoder()
    const chunk = Buffer.concat([
      encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.ping, { n: 1 }),
      encodeDiscordIpcPacket(DISCORD_IPC_OPCODE.frame, { evt: 'ERROR' })
    ])
    expect(decoder.push(chunk)).toEqual([
      { op: DISCORD_IPC_OPCODE.ping, payload: { n: 1 } },
      { op: DISCORD_IPC_OPCODE.frame, payload: { evt: 'ERROR' } }
    ])
  })

  it('rejects a header that declares an implausibly large body', () => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(DISCORD_IPC_OPCODE.frame, 0)
    header.writeUInt32LE(64 * 1024 * 1024, 4)
    expect(() => new DiscordIpcPacketDecoder().push(header)).toThrow(/too large/)
  })
})
