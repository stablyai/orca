export const SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES = 64 * 1024

const STDERR_PREFIX_BYTES = 4 * 1024
const STDERR_TAIL_BYTES = SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES - STDERR_PREFIX_BYTES
const STDERR_EVIDENCE_CHARS_PER_END = 500

export class SpeechModelExtractionStderr {
  private readonly prefix = Buffer.alloc(STDERR_PREFIX_BYTES)
  private readonly tail = Buffer.alloc(STDERR_TAIL_BYTES)
  private prefixLength = 0
  private tailLength = 0
  private tailWriteOffset = 0
  private observedBytes = 0

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return
    }
    if (this.prefixLength < this.prefix.length) {
      const prefixBytes = Math.min(chunk.length, this.prefix.length - this.prefixLength)
      chunk.copy(this.prefix, this.prefixLength, 0, prefixBytes)
      this.prefixLength += prefixBytes
    }
    this.appendTail(chunk)
    this.observedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.observedBytes + chunk.length)
  }

  retainedByteLength(): number {
    return Math.min(this.observedBytes, SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES)
  }

  wasTruncated(): boolean {
    return this.observedBytes > SPEECH_MODEL_EXTRACTION_STDERR_MAX_RETAINED_BYTES
  }

  errorEvidence(): string {
    const prefix = this.prefix
      .subarray(0, this.prefixLength)
      .toString('utf8')
      .slice(0, STDERR_EVIDENCE_CHARS_PER_END)
    if (!this.wasTruncated()) {
      return prefix
    }
    const omittedBytes = this.observedBytes - this.retainedByteLength()
    const tail = this.orderedTail().toString('utf8').slice(-STDERR_EVIDENCE_CHARS_PER_END)
    return `${prefix}\n[... ${omittedBytes} stderr bytes omitted ...]\n${tail}`
  }

  private appendTail(chunk: Buffer): void {
    if (chunk.length >= this.tail.length) {
      chunk.copy(this.tail, 0, chunk.length - this.tail.length)
      this.tailLength = this.tail.length
      this.tailWriteOffset = 0
      return
    }
    const firstBytes = Math.min(chunk.length, this.tail.length - this.tailWriteOffset)
    chunk.copy(this.tail, this.tailWriteOffset, 0, firstBytes)
    if (firstBytes < chunk.length) {
      chunk.copy(this.tail, 0, firstBytes)
    }
    this.tailWriteOffset = (this.tailWriteOffset + chunk.length) % this.tail.length
    this.tailLength = Math.min(this.tail.length, this.tailLength + chunk.length)
  }

  private orderedTail(): Buffer {
    if (this.tailLength < this.tail.length || this.tailWriteOffset === 0) {
      return this.tail.subarray(0, this.tailLength)
    }
    return Buffer.concat([
      this.tail.subarray(this.tailWriteOffset),
      this.tail.subarray(0, this.tailWriteOffset)
    ])
  }
}
