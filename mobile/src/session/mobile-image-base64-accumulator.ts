const MOBILE_IMAGE_BASE64_BINARY_CHUNK_BYTES = 8190
const MOBILE_IMAGE_BASE64_CHUNK_BYTES = 256 * 1024 - 1

function encodeMobileImageBytes(bytes: Uint8Array): string {
  const encoded: string[] = []
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += MOBILE_IMAGE_BASE64_BINARY_CHUNK_BYTES
  ) {
    const end = Math.min(offset + MOBILE_IMAGE_BASE64_BINARY_CHUNK_BYTES, bytes.byteLength)
    let binary = ''
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]!)
    }
    encoded.push(btoa(binary))
  }
  return encoded.join('')
}

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
    this.encodedChunks.push(encodeMobileImageBytes(this.staging.subarray(0, this.stagingLength)))
    this.stagingLength = 0
  }
}
