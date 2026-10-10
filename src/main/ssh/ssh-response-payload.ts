import { GrowingByteBuffer } from '@orca/process-host/growing-byte-buffer'

export class SshResponsePayload {
  private readonly bytes = new GrowingByteBuffer()
  private receivedChunks = 0

  constructor(
    readonly totalBytes: number,
    readonly chunkCount: number,
    private readonly maxResponseBytes?: number
  ) {
    if (
      !Number.isSafeInteger(totalBytes) ||
      !Number.isSafeInteger(chunkCount) ||
      chunkCount > totalBytes ||
      (totalBytes > 0 && chunkCount === 0)
    ) {
      throw new Error('Invalid git response chunk count or byte total')
    }
    if (maxResponseBytes !== undefined && totalBytes > maxResponseBytes) {
      throw new Error('Filesystem response exceeds the retention budget')
    }
  }

  append(data: string): void {
    if (this.receivedChunks >= this.chunkCount) {
      throw new Error('Git response exceeds its declared chunk count')
    }
    if (
      this.maxResponseBytes !== undefined &&
      data.length > Math.ceil(this.maxResponseBytes / 3) * 4
    ) {
      throw new Error('Filesystem response exceeds the retention budget')
    }
    const remaining = this.totalBytes - this.bytes.byteLength
    if (data.length > Math.ceil(remaining / 3) * 4) {
      throw new Error('Git response exceeds its declared byte total')
    }
    const decoded = Buffer.from(data, 'base64')
    if (decoded.length === 0) {
      throw new Error('Git response chunk made no byte progress')
    }
    if (
      this.maxResponseBytes !== undefined &&
      this.bytes.byteLength + decoded.length > this.maxResponseBytes
    ) {
      throw new Error('Filesystem response exceeds the retention budget')
    }
    if (decoded.length > remaining) {
      throw new Error('Git response exceeds its declared byte total')
    }
    this.bytes.append(decoded)
    this.receivedChunks += 1
  }

  get receivedBytes(): number {
    return this.bytes.byteLength
  }

  takeString(): string {
    return this.bytes.takeString()
  }

  clear(): void {
    this.bytes.clear()
  }
}
