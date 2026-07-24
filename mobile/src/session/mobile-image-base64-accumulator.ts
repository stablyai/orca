import { Buffer } from 'buffer'

const MOBILE_IMAGE_BASE64_CHUNK_BYTES = 256 * 1024 - 1

export class MobileImageBase64Accumulator {
  private readonly staging = new Uint8Array(MOBILE_IMAGE_BASE64_CHUNK_BYTES)
  private readonly encodedChunks: string[] = []
  private stagingLength = 0

  append(bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.byteLength) {
      const copied = Math.min(
        this.staging.byteLength - this.stagingLength,
        bytes.byteLength - offset
      )
      this.staging.set(bytes.subarray(offset, offset + copied), this.stagingLength)
      this.stagingLength += copied
      offset += copied
      if (this.stagingLength === this.staging.byteLength) {
        this.flushStaging()
      }
    }
  }

  finish(): string {
    this.flushStaging()
    return this.encodedChunks.join('')
  }

  private flushStaging(): void {
    if (this.stagingLength === 0) {
      return
    }
    this.encodedChunks.push(
      Buffer.from(this.staging.subarray(0, this.stagingLength)).toString('base64')
    )
    this.stagingLength = 0
  }
}
