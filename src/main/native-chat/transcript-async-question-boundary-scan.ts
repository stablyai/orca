// Backward scan of a Codex rollout from a byte boundary to the newest delivered user
// message (or a floor offset, by default the start of the file). It keeps only
// async-question facts, never messages, so memory is O(pending questions) however much
// output follows them.

import type { NativeChatAsyncQuestionFact } from '../../shared/native-chat-async-questions'
import {
  CODEX_OVERSIZED_RECORD_HEAD_BYTES,
  codexOversizedRolloutRecordFacts,
  codexRolloutAsyncQuestionFacts
} from './codex-rollout-async-question-facts'
import { transcriptFallbackId } from './transcript-fallback-id'
import { TAIL_CHUNK_BYTES } from './transcript-tail-boundary'
import { MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES } from './transcript-tail-reader'
import { closeTranscriptHandle, wslGatedOpen, wslGatedRead } from './wsl-transcript-fs-access'

export class TranscriptBoundaryScanShrankError extends Error {
  constructor() {
    super('Transcript shrank during the async-question scan')
  }
}

export type CodexAsyncQuestionScan = {
  /** Facts after the boundary (or the floor), in file order. */
  facts: NativeChatAsyncQuestionFact[]
  /** Whether a delivered user message was found, so nothing before it matters. */
  reachedBoundary: boolean
}

/** Facts after the newest delivered user message in [`floorOffset`, `endOffset`). Both offsets
 *  are line starts/ends. */
export async function scanCodexAsyncQuestionFactsBefore(
  filePath: string,
  endOffset: number,
  signal?: AbortSignal,
  floorOffset = 0
): Promise<CodexAsyncQuestionScan> {
  if (endOffset <= floorOffset) {
    return { facts: [], reachedBoundary: false }
  }
  const newestFirst: NativeChatAsyncQuestionFact[][] = []
  const handle = await wslGatedOpen(filePath, 'exact', signal)
  try {
    const lineParts: Buffer[] = []
    let lineBytes = 0
    let lineOversized = false
    // An oversized line's first bytes (parts arrive newest-first, so each one is prepended).
    let oversizedHead = Buffer.alloc(0)
    // Returns true once the boundary (a delivered user message) is reached.
    const handleLine = (lineOffset: number): boolean => {
      const oversized = lineOversized
      const head = oversizedHead
      const bytes = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts.toReversed())
      lineParts.length = 0
      lineBytes = 0
      lineOversized = false
      oversizedHead = Buffer.alloc(0)
      if (oversized) {
        return codexOversizedRolloutRecordFacts(head.toString('utf8')).length > 0
      }
      if (!bytes || bytes.length === 0) {
        return false
      }
      let line = bytes.toString('utf8')
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      const facts = codexRolloutAsyncQuestionFacts(line, transcriptFallbackId(filePath, lineOffset))
      if (facts.some((fact) => fact.kind === 'delivered-user-message')) {
        return true
      }
      if (facts.length > 0) {
        newestFirst.push(facts)
      }
      return false
    }
    const retainPart = (part: Buffer): void => {
      if (part.length === 0) {
        return
      }
      if (lineOversized) {
        oversizedHead = Buffer.concat([part, oversizedHead]).subarray(
          0,
          CODEX_OVERSIZED_RECORD_HEAD_BYTES
        )
        return
      }
      lineBytes += part.length
      if (lineBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
        oversizedHead = Buffer.concat([part, ...lineParts.toReversed()]).subarray(
          0,
          CODEX_OVERSIZED_RECORD_HEAD_BYTES
        )
        lineParts.length = 0
        lineOversized = true
        return
      }
      lineParts.push(part)
    }

    // `endOffset` is a line end, so the byte before it is that line's newline.
    let cursor = endOffset - 1
    let reachedBoundary = false
    while (cursor > floorOffset && !reachedBoundary) {
      signal?.throwIfAborted()
      const start = Math.max(floorOffset, cursor - TAIL_CHUNK_BYTES)
      const buffer = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await wslGatedRead(
        handle,
        filePath,
        buffer,
        0,
        buffer.length,
        start,
        'exact',
        signal
      )
      signal?.throwIfAborted()
      if (bytesRead < buffer.length) {
        throw new TranscriptBoundaryScanShrankError()
      }
      let segmentEnd = bytesRead
      for (let index = bytesRead - 1; index >= 0; index--) {
        if (buffer[index] !== 0x0a) {
          continue
        }
        retainPart(buffer.subarray(index + 1, segmentEnd))
        segmentEnd = index
        if (handleLine(start + index + 1)) {
          reachedBoundary = true
          break
        }
      }
      if (!reachedBoundary && segmentEnd > 0) {
        retainPart(buffer.subarray(0, segmentEnd))
      }
      cursor = start
    }
    if (!reachedBoundary && cursor === floorOffset) {
      reachedBoundary = handleLine(floorOffset)
    }
    return { facts: newestFirst.toReversed().flat(), reachedBoundary }
  } finally {
    await closeTranscriptHandle(handle, filePath)
  }
}
