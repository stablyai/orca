export const DISCORD_IPC_OPCODE = {
  handshake: 0,
  frame: 1,
  close: 2,
  ping: 3,
  pong: 4
} as const

// Why: Discord payloads are small JSON; a huge declared length means a corrupt stream, not a frame worth buffering.
const MAX_PACKET_BODY_BYTES = 1024 * 1024
const HEADER_BYTES = 8

export type DiscordIpcPacket = {
  op: number
  payload: unknown
}

/** Header and body go out as one buffer: Discord expects each packet in a single write. */
export function encodeDiscordIpcPacket(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const packet = Buffer.alloc(HEADER_BYTES + body.length)
  packet.writeUInt32LE(op, 0)
  packet.writeUInt32LE(body.length, 4)
  body.copy(packet, HEADER_BYTES)
  return packet
}

export class DiscordIpcPacketDecoder {
  private pending: Buffer = Buffer.alloc(0)

  /** Throws on a corrupt stream; the caller should drop the connection. */
  push(chunk: Buffer): DiscordIpcPacket[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const packets: DiscordIpcPacket[] = []
    while (this.pending.length >= HEADER_BYTES) {
      const length = this.pending.readUInt32LE(4)
      if (length > MAX_PACKET_BODY_BYTES) {
        throw new Error(`discord ipc packet too large: ${length}`)
      }
      if (this.pending.length < HEADER_BYTES + length) {
        break
      }
      const op = this.pending.readUInt32LE(0)
      const body = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8')
      this.pending = this.pending.subarray(HEADER_BYTES + length)
      const payload: unknown = body.length === 0 ? null : JSON.parse(body)
      packets.push({ op, payload })
    }
    return packets
  }
}
