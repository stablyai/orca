import type { EmulatorVideoStreamFrameMessage } from '../../shared/emulator-video-stream'

const MAX_PACKET_BYTES = 32 * 1024 * 1024

export type AvccFrame = Omit<EmulatorVideoStreamFrameMessage, 'streamId' | 'deviceId'>

export class AvccFrameParser {
  private readonly header = new Uint8Array(5)
  private readonly headerView = new DataView(this.header.buffer)
  private headerUsed = 0
  private payload: Uint8Array<ArrayBuffer> | null = null
  private payloadUsed = 0
  private tag = 0

  constructor(private readonly onFrame: (frame: AvccFrame) => void) {}

  push(chunk: Uint8Array): void {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (!this.payload) {
        const take = Math.min(this.header.byteLength - this.headerUsed, chunk.byteLength - offset)
        this.header.set(chunk.subarray(offset, offset + take), this.headerUsed)
        this.headerUsed += take
        offset += take
        if (this.headerUsed !== this.header.byteLength) {
          continue
        }
        const length = this.headerView.getUint32(0, false)
        if (length < 2 || length > MAX_PACKET_BYTES) {
          throw new Error(`Invalid AVCC packet length ${length}.`)
        }
        this.tag = this.header[4]
        if (this.tag < 1 || this.tag > 4) {
          throw new Error(`Invalid AVCC packet tag ${this.tag}.`)
        }
        this.payload = new Uint8Array(new ArrayBuffer(length - 1))
        this.payloadUsed = 0
        this.headerUsed = 0
      }
      const payload = this.payload
      const take = Math.min(payload.byteLength - this.payloadUsed, chunk.byteLength - offset)
      payload.set(chunk.subarray(offset, offset + take), this.payloadUsed)
      this.payloadUsed += take
      offset += take
      if (this.payloadUsed !== payload.byteLength) {
        continue
      }
      const frame: AvccFrame = {
        config: this.tag === 1,
        keyFrame: this.tag === 2,
        bytes: payload.buffer
      }
      if (this.tag === 4) {
        frame.seed = true
      }
      this.payload = null
      this.payloadUsed = 0
      this.onFrame(frame)
    }
  }

  reset(): void {
    this.headerUsed = 0
    this.payload = null
    this.payloadUsed = 0
  }
}
