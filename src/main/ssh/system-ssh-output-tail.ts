export const SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES = 64 * 1024

const TRUNCATION_NOTICE = '[earlier system SSH output truncated]\n'

export class SystemSshOutputTail {
  private buffer = Buffer.alloc(0)
  private truncated = false

  constructor(private readonly maxBytes = SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('System SSH output tail limit must be a non-negative safe integer')
    }
  }

  push(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (chunk.byteLength >= this.maxBytes) {
      const hadBufferedOutput = this.buffer.byteLength > 0
      this.buffer = Buffer.from(chunk.subarray(chunk.byteLength - this.maxBytes))
      this.truncated ||= hadBufferedOutput || chunk.byteLength > this.maxBytes
      return
    }
    const combinedBytes = this.buffer.byteLength + chunk.byteLength
    if (combinedBytes <= this.maxBytes) {
      this.buffer = Buffer.concat([this.buffer, chunk], combinedBytes)
      return
    }
    const discardBytes = combinedBytes - this.maxBytes
    this.buffer = Buffer.concat([this.buffer.subarray(discardBytes), chunk], this.maxBytes)
    this.truncated = true
  }

  toString(): string {
    const text = this.buffer.toString('utf8')
    return this.truncated ? `${TRUNCATION_NOTICE}${text}` : text
  }
}
