import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'

export class TranscriptRecordBuffer {
  private readonly retained = new GrowingByteBuffer()
  private observedBytes = 0
  private oversized = false

  constructor(private readonly maxRetainedBytes: number) {
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) {
      throw new RangeError('Transcript record limit must be a non-negative safe integer')
    }
  }

  append(part: Buffer | Uint8Array): void {
    this.observedBytes += part.byteLength
    if (this.oversized) {
      return
    }
    if (this.observedBytes > this.maxRetainedBytes) {
      this.retained.clear()
      this.oversized = true
      return
    }
    this.retained.append(part)
  }

  clear(): void {
    this.retained.clear()
    this.observedBytes = 0
    this.oversized = false
  }

  toString(): string {
    return this.retained.toString('utf8')
  }

  get byteLength(): number {
    return this.observedBytes
  }

  get isOversized(): boolean {
    return this.oversized
  }
}
