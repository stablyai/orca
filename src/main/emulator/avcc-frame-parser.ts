// serve-sim /stream.avcc wire: u32 big-endian length (tag + payload), then a one-byte tag:
// 1 avcC description, 2 IDR, 3 delta, 4 connect-time JPEG seed.
const DESCRIPTION_TAG = 1
const KEY_FRAME_TAG = 2
const SEED_TAG = 4
const MAX_PACKET_BYTES = 32 * 1024 * 1024

export type AvccFrame = { config: boolean; keyFrame: boolean; seed: boolean; bytes: ArrayBuffer }

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
        if (this.headerUsed < this.header.byteLength) {
          return
        }
        const length = this.headerView.getUint32(0, false)
        this.tag = this.header[4]
        if (
          length < 2 ||
          length > MAX_PACKET_BYTES ||
          this.tag < DESCRIPTION_TAG ||
          this.tag > SEED_TAG
        ) {
          throw new Error(`Invalid simulator video packet (length ${length}, tag ${this.tag}).`)
        }
        this.payload = new Uint8Array(length - 1)
        this.payloadUsed = 0
        this.headerUsed = 0
      }
      const take = Math.min(this.payload.byteLength - this.payloadUsed, chunk.byteLength - offset)
      this.payload.set(chunk.subarray(offset, offset + take), this.payloadUsed)
      this.payloadUsed += take
      offset += take
      if (this.payloadUsed < this.payload.byteLength) {
        return
      }
      const bytes = this.payload.buffer
      this.payload = null
      this.onFrame({
        config: this.tag === DESCRIPTION_TAG,
        keyFrame: this.tag === KEY_FRAME_TAG,
        seed: this.tag === SEED_TAG,
        bytes
      })
    }
  }
}
