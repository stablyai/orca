import { setImmediate } from 'node:timers/promises'
import {
  TRANSCRIPT_RANGES_UNSETTLED,
  transcriptDigestHex,
  type TranscriptByteRange,
  type TranscriptRangeVerification
} from '../../../shared/native-chat/transcript/transcript-byte-range'
import {
  closeTranscriptHandle,
  openTranscriptFile,
  readTranscriptFile
} from '../transcript-filesystem/wsl-transcript-fs-access'
import { readTranscriptFileVersion, transcriptFileVersionChanged } from './transcript-file-version'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  transcriptLineDigest
} from './transcript-byte-digest'

export async function verifyTranscriptRanges(
  filePath: string,
  ranges: readonly TranscriptByteRange[],
  signal?: AbortSignal
): Promise<TranscriptRangeVerification> {
  try {
    signal?.throwIfAborted()
    const before = await readTranscriptFileVersion(filePath, signal)
    const handle = await openTranscriptFile(filePath, 'exact', signal)
    const results: boolean[] = []
    try {
      for (const range of ranges) {
        if (range.start < 0 || range.end <= range.start || range.end > before.size) {
          results.push(false)
          continue
        }
        let offset = range.start
        let lineStart = offset
        let length = 0
        let parts: Buffer[] = []
        let sum = 0n
        const finish = (): void => {
          sum += transcriptLineDigest(lineStart, Buffer.concat(parts), length)
          parts = []
          length = 0
        }
        while (offset < range.end) {
          signal?.throwIfAborted()
          // Lines can span chunks and keep subarrays, so each chunk gets its own buffer.
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, range.end - offset))
          const { bytesRead } = await readTranscriptFile(
            handle,
            filePath,
            buffer,
            0,
            buffer.length,
            offset,
            'exact',
            signal
          )
          const chunk = buffer.subarray(0, bytesRead)
          if (chunk.length === 0) {
            break
          }
          let start = 0
          for (let i = 0; i <= chunk.length; i++) {
            if (i !== chunk.length && chunk[i] !== 0x0a) {
              continue
            }
            const part = chunk.subarray(start, i)
            length += part.length
            if (length <= MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
              parts.push(part)
            } else {
              parts = []
            }
            if (i < chunk.length) {
              finish()
              lineStart = offset + i + 1
            }
            start = i + 1
          }
          offset += chunk.length
          await setImmediate(undefined, { signal })
        }
        if (length > 0) {
          finish()
        }
        results.push(offset === range.end && transcriptDigestHex(sum) === range.digest)
      }
    } finally {
      await closeTranscriptHandle(handle, filePath)
    }
    const after = await readTranscriptFileVersion(filePath, signal)
    // A swap or a shrink into held bytes is a rewrite; appends past them leave the hash valid.
    const heldEnd = Math.max(...ranges.map((range) => range.end))
    if (after.identity !== before.identity || after.size < heldEnd) {
      return ranges.map(() => false)
    }
    return after.size === before.size && transcriptFileVersionChanged(after, before)
      ? TRANSCRIPT_RANGES_UNSETTLED
      : results
  } catch {
    signal?.throwIfAborted()
    return ranges.map(() => false)
  }
}
