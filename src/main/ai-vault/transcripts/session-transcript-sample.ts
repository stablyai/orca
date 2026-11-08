import { createHash } from 'node:crypto'

const SAMPLE_BYTES = 4096

export type TranscriptSample = { head: Buffer; tail: Buffer }

/** Return bounded byte windows without mutating samples retained at an earlier line boundary. */
export function appendTranscriptSample(sample: TranscriptSample, bytes: Buffer): TranscriptSample {
  if (bytes.length === 0) {
    return sample
  }
  const head =
    sample.head.length < SAMPLE_BYTES
      ? Buffer.concat([sample.head, bytes.subarray(0, SAMPLE_BYTES - sample.head.length)])
      : sample.head
  const tail =
    bytes.length >= SAMPLE_BYTES
      ? Buffer.from(bytes.subarray(-SAMPLE_BYTES))
      : Buffer.concat([
          sample.tail.subarray(Math.max(0, sample.tail.length + bytes.length - SAMPLE_BYTES)),
          bytes
        ])
  return { head, tail }
}

/** Hash disjoint head/tail ranges through the committed offset; overlapping bytes count once. */
export function hashTranscriptSample(sample: TranscriptSample, byteOffset: number): string {
  const tailLength = Math.min(SAMPLE_BYTES, Math.max(0, byteOffset - sample.head.length))
  return createHash('sha256')
    .update(sample.head)
    .update(sample.tail.subarray(sample.tail.length - tailLength))
    .digest('hex')
}
