import type { Hash } from 'node:crypto'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  MAX_SESSION_TRANSCRIPT_RECORD_BYTES,
  type SkippedTranscriptRecord
} from './session-transcript-record-budget'

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

type JsonlReadResult = {
  consumedThrough: number
  trailingPartialLine: string | null
  bytesRead: number
  skippedRecords: SkippedTranscriptRecord[]
  /** Hash of bytes [0, consumedThrough), present when the caller supplied one for [0, start). */
  prefixHash?: Hash
}

export type JsonlPrefixCheckpoints = {
  offsets: ReadonlySet<number>
  /** Called once the consumed prefix ends at an offset, before the next line is read. */
  reached: (offset: number, digest: string) => void
}

// Track byte offsets across whole records; oversized records are skipped without dropping the session.
export async function consumeCompleteJsonlLines(args: {
  path: string
  start: number
  onLine: (line: string) => void
  onLineBytes?: (line: Buffer) => void
  /** Covers [0, start); extended through each complete line and returned for the new end. */
  prefixHash?: Hash | null
  prefixCheckpoints?: JsonlPrefixCheckpoints
  shouldStop?: () => boolean
  signal?: AbortSignal
}): Promise<JsonlReadResult> {
  throwIfAiVaultScanCancelled(args.signal)
  if (args.shouldStop?.()) {
    return {
      consumedThrough: args.start,
      trailingPartialLine: null,
      bytesRead: 0,
      skippedRecords: [],
      ...(args.prefixHash ? { prefixHash: args.prefixHash } : {})
    }
  }
  const hash = args.prefixHash ?? null
  // Set once hash has absorbed a partial tail, so it no longer ends at consumedThrough.
  let committedHash: Hash | null = null
  let consumedThrough = args.start
  let bytesRead = 0
  // A piece list avoids O(record^2) copying when one record spans many chunks.
  let remainderParts: Buffer[] = []
  let remainderLength = 0
  let stopped = false
  // Discard an oversized record through its newline while retaining its exact start offset.
  let discarding = false
  const skippedRecords: SkippedTranscriptRecord[] = []

  const stream = openTranscriptReadStream(args.path, { start: args.start }, 'scan', args.signal)
  let chunkStart = args.start
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    // Check per chunk so cancellation also interrupts giant records and releases the stream.
    throwIfAiVaultScanCancelled(args.signal)
    bytesRead += chunk.length
    const chunkEnd = chunkStart + chunk.length
    let lineStart = 0
    let hashedThrough = 0
    let newlineIndex = chunk.indexOf(NEWLINE_BYTE, lineStart)
    while (newlineIndex !== -1) {
      const newlineOffset = chunkStart + newlineIndex
      const recordLength = newlineOffset - consumedThrough
      if (discarding || recordLength > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
        skippedRecords.push({ byteOffset: consumedThrough, approximateBytes: recordLength })
        remainderParts = []
        remainderLength = 0
        discarding = false
      } else {
        let line = chunk.subarray(lineStart, newlineIndex)
        // Only the first line carries a prefix; reset here to avoid allocations for complete lines.
        if (remainderLength > 0) {
          line = Buffer.concat([...remainderParts, line], recordLength)
          remainderParts = []
          remainderLength = 0
        }
        const lineEnd = line.at(-1) === CARRIAGE_RETURN_BYTE ? line.length - 1 : line.length
        if (args.onLineBytes) {
          args.onLineBytes(line.subarray(0, lineEnd))
        } else {
          args.onLine(line.toString('utf-8', 0, lineEnd))
        }
      }
      consumedThrough = newlineOffset + 1
      lineStart = newlineIndex + 1
      if (hash) {
        hash.update(chunk.subarray(hashedThrough, lineStart))
        hashedThrough = lineStart
        committedHash = null
        if (args.prefixCheckpoints?.offsets.has(consumedThrough)) {
          args.prefixCheckpoints.reached(consumedThrough, hash.copy().digest('hex'))
        }
      }
      if (args.shouldStop?.()) {
        stopped = true
        break
      }
      newlineIndex = chunk.indexOf(NEWLINE_BYTE, lineStart)
    }
    if (hash && !stopped && hashedThrough < chunk.length) {
      committedHash ??= hash.copy()
      hash.update(chunk.subarray(hashedThrough))
    }
    if (stopped) {
      remainderParts = []
      remainderLength = 0
      break
    }
    if (lineStart < chunk.length && !discarding) {
      // Include carried prefixes when budgeting an unterminated record.
      if (chunkEnd - consumedThrough > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
        remainderParts = []
        remainderLength = 0
        discarding = true
      } else {
        // Copy a partial tail so retaining it does not pin the whole chunk buffer.
        remainderParts.push(lineStart === 0 ? chunk : Buffer.from(chunk.subarray(lineStart)))
        remainderLength = chunkEnd - consumedThrough
      }
    }
    chunkStart = chunkEnd
  }

  if (discarding) {
    // An unterminated oversized record can still grow; retain its start as the next resume offset.
    skippedRecords.push({
      byteOffset: consumedThrough,
      approximateBytes: chunkStart - consumedThrough
    })
  }

  return {
    consumedThrough,
    trailingPartialLine:
      remainderLength > 0
        ? (remainderParts.length === 1
            ? remainderParts[0]
            : Buffer.concat(remainderParts, remainderLength)
          ).toString('utf-8')
        : null,
    bytesRead,
    skippedRecords,
    ...(hash ? { prefixHash: committedHash ?? hash } : {})
  }
}
