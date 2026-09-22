import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
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
  /** Records dropped for exceeding the per-record byte budget. */
  skippedRecords: SkippedTranscriptRecord[]
}

// Byte-accurate JSONL fold: offsets count bytes rather than decoded UTF-8
// characters, so an incremental read resumes at an exact line boundary.
//
// A record that outgrows the budget is discarded up to its newline rather than
// failing the fold, so one oversized record costs one record, not the session.
// The in-progress record always starts at `consumedThrough`, which is what makes
// both its running size and the resume offset past a discarded span exact.
export async function consumeCompleteJsonlLines(args: {
  path: string
  start: number
  onLine: (line: string) => void
  onLineBytes?: (line: Buffer) => void
  shouldStop?: () => boolean
}): Promise<JsonlReadResult> {
  if (args.shouldStop?.()) {
    return {
      consumedThrough: args.start,
      trailingPartialLine: null,
      bytesRead: 0,
      skippedRecords: []
    }
  }
  let consumedThrough = args.start
  let bytesRead = 0
  // A piece list avoids O(record^2) copying when one record spans many chunks.
  let remainderParts: Buffer[] = []
  let remainderLength = 0
  let stopped = false
  // Set once the record starting at `consumedThrough` blew the budget: its
  // bytes are dropped on sight until the newline that ends it.
  let discarding = false
  const skippedRecords: SkippedTranscriptRecord[] = []

  const stream = openTranscriptReadStream(args.path, { start: args.start }, 'scan')
  let chunkStart = args.start
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytesRead += chunk.length
    const chunkEnd = chunkStart + chunk.length
    let lineStart = 0
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
        // Only the first line of a chunk can carry a prefix; resetting inside the
        // branch keeps the common per-line path allocation-free.
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
      if (args.shouldStop?.()) {
        stopped = true
        break
      }
      newlineIndex = chunk.indexOf(NEWLINE_BYTE, lineStart)
    }
    if (stopped) {
      remainderParts = []
      remainderLength = 0
      break
    }
    if (lineStart < chunk.length && !discarding) {
      // The unterminated tail is the whole in-progress record, prefix included.
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
    // No terminator yet, so the record may still be growing: leave the cursor at
    // its start and let the next read re-skip it from the same offset.
    skippedRecords.push({
      byteOffset: consumedThrough,
      approximateBytes: chunkStart - consumedThrough
    })
  }

  return {
    consumedThrough,
    trailingPartialLine:
      remainderLength > 0 ? Buffer.concat(remainderParts, remainderLength).toString('utf-8') : null,
    bytesRead,
    skippedRecords
  }
}
