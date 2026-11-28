import { RexReadGate } from './rex-read-gate'
import { handshakeRexWire, type RexWire } from './rex-wire'
import { REX_MAX_SNAPSHOT_BYTES } from './rex-memory-budget'
import { RexSnapshotFramer } from './rex-snapshot-framing'

const TIMEOUT = 5000

type StreamHandshake = {
  wire: RexWire
  reconnectToken: Buffer
  nonce: bigint
  retentionMs: number
}

async function handshake(
  path: string,
  message: Buffer,
  signal?: AbortSignal
): Promise<StreamHandshake> {
  return handshakeRexWire(
    path,
    '/api/data',
    'rex.data.terminal.v1',
    async (wire) => {
      wire.send(message)
      const ack = await wire.next(TIMEOUT)
      if (ack.length !== 32 || ack[0] !== 0x81) {
        throw new Error('Rex data handshake rejected')
      }
      const nonce = ack.readBigUInt64LE(24)
      if (!nonce) {
        throw new Error('Invalid Rex nonce')
      }
      return {
        wire,
        reconnectToken: Buffer.from(ack.subarray(1, 17)),
        retentionMs: ack.readUInt32LE(20),
        nonce
      }
    },
    signal
  )
}

export class RexDataStream {
  private reading = false
  private readonly lifetime = new AbortController()
  private readonly delivery = new RexReadGate()

  private get closed(): boolean {
    return this.lifetime.signal.aborted
  }

  private constructor(
    private readonly path: string,
    private current: StreamHandshake,
    private offset: bigint
  ) {}

  static async open(
    path: string,
    ticket: string,
    retainSnapshot = false
  ): Promise<{ stream: RexDataStream; tail: Buffer; nonce: bigint; snapshot?: Buffer }> {
    const token = Buffer.from(ticket, 'base64url')
    if (token.length !== 16) {
      throw new Error('Invalid Rex ticket')
    }
    const current = await handshake(path, Buffer.concat([Buffer.from([1]), token]))
    try {
      const snapshot = new RexSnapshotFramer()
      const chunks: Buffer[] = []
      let retainedBytes = 0
      const deadline = Date.now() + TIMEOUT
      let offset = 0n
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error('Rex snapshot timed out')
        }
        const frame = await current.wire.next(remaining)
        offset += BigInt(frame.length)
        const end = snapshot.feed(frame)
        if (retainSnapshot) {
          const part = end === null ? frame : frame.subarray(0, end)
          retainedBytes += part.length
          if (retainedBytes > REX_MAX_SNAPSHOT_BYTES || chunks.length >= 16384) {
            throw new Error('Rex retained snapshot exceeds budget')
          }
          chunks.push(part)
        }
        if (end !== null) {
          return {
            stream: new RexDataStream(path, current, offset),
            tail: frame.subarray(end),
            nonce: current.nonce,
            ...(retainSnapshot ? { snapshot: Buffer.concat(chunks) } : {})
          }
        }
      }
    } catch (error) {
      current.wire.close()
      throw error
    }
  }

  pauseDelivery(): void {
    this.delivery.pause()
  }

  resumeDelivery(): void {
    this.delivery.resume()
  }

  waitForDelivery(): Promise<void> {
    return this.delivery.wait()
  }

  async next(): Promise<Buffer> {
    if (this.reading) {
      throw new Error('Rex data stream requires a single reader')
    }
    this.reading = true
    try {
      return await this.readNext()
    } finally {
      this.reading = false
    }
  }

  private async readNext(): Promise<Buffer> {
    await this.waitForDelivery()
    if (this.closed) {
      throw new Error('Rex data stream closed')
    }
    let frame: Buffer
    try {
      frame = await this.current.wire.next()
    } catch (error) {
      if (this.closed || !this.current.wire.canResume || !this.current.retentionMs) {
        throw error
      }
      // Reconnect only this exact stream. Never silently replace it with a fresh snapshot.
      const previous = this.current
      previous.wire.close()
      const message = Buffer.alloc(25)
      message[0] = 2
      previous.reconnectToken.copy(message, 1)
      message.writeBigUInt64LE(this.offset, 17)
      const resumed = await handshake(this.path, message, this.lifetime.signal)
      if (this.closed || resumed.nonce !== previous.nonce) {
        resumed.reconnectToken.fill(0)
        resumed.wire.close()
        throw new Error('Rex resumed stream identity mismatch')
      }
      previous.reconnectToken.fill(0)
      this.current = resumed
      frame = await resumed.wire.next()
    }
    if (this.closed) {
      throw new Error('Rex data stream closed')
    }
    this.offset += BigInt(frame.length)
    return frame
  }

  async probeWake(): Promise<boolean> {
    const current = this.current
    const healthy = await current.wire.probeWake()
    return !this.closed && (healthy || this.current !== current)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.lifetime.abort(new Error('Rex data stream closed'))
    this.delivery.close()
    this.current.reconnectToken.fill(0)
    this.current.wire.close()
  }
}
