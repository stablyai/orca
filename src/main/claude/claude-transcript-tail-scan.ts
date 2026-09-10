import { open } from 'node:fs/promises'

const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024
export const TRANSCRIPT_TAIL_READ_LIMIT_BYTES = 4 * 1024 * 1024
const NEWLINE = 0x0a

export type ClaudeTranscriptTailScan = {
  reachedFileStart: boolean
}

/** Reads backwards with bounded memory; oversized transcript records are skipped. */
export async function* claudeTranscriptTailLines(
  transcriptPath: string,
  scan?: ClaudeTranscriptTailScan,
  maxBytes = TRANSCRIPT_TAIL_READ_LIMIT_BYTES
): AsyncGenerator<string, void, undefined> {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    let end = size
    const lowerBound = Math.max(0, size - maxBytes)
    let parts: Buffer[] = []
    let lineBytes = 0
    let oversized = false
    if (scan) {
      scan.reachedFileStart = size === 0
    }
    while (end > lowerBound) {
      const position = Math.max(lowerBound, end - TRANSCRIPT_TAIL_CHUNK_BYTES)
      const buffer = Buffer.alloc(end - position)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead !== buffer.length) {
        return
      }
      let segmentEnd = buffer.length
      for (let index = buffer.length - 1; index >= 0; index--) {
        if (buffer[index] !== NEWLINE) {
          continue
        }
        retain(buffer.subarray(index + 1, segmentEnd))
        const line = finish()
        if (line) {
          yield line
        }
        segmentEnd = index
      }
      retain(buffer.subarray(0, segmentEnd))
      end = position
    }
    if (end === 0) {
      if (scan) {
        scan.reachedFileStart = true
      }
      const line = finish()
      if (line) {
        yield line
      }
    }

    function retain(part: Buffer): void {
      if (oversized || part.length === 0) {
        return
      }
      lineBytes += part.length
      if (lineBytes > TRANSCRIPT_TAIL_READ_LIMIT_BYTES) {
        parts = []
        oversized = true
        return
      }
      parts.push(part)
    }

    function finish(): string | null {
      const line = oversized ? null : Buffer.concat(parts.toReversed()).toString('utf8').trim()
      parts = []
      lineBytes = 0
      oversized = false
      return line || null
    }
  } finally {
    await file.close()
  }
}
