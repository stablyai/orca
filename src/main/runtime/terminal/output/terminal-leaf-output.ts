import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord
} from '../records/runtime-terminal-state-records'
import { appendNormalizedToTailBuffer } from './tail/terminal-tail-buffer'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'
import {
  appendCompletedTerminalTranscript,
  buildPreview,
  tailStateMatches
} from './tail/terminal-tail-state'
import {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason
} from '../wait/terminal-wait-tail-state'

export function appendTerminalLeafOutput(
  leaf: RuntimeLeafRecord,
  pty: RuntimePtyWorktreeRecord | null,
  ptyTailBefore: Parameters<typeof tailStateMatches>[7] | null,
  ptyTailAfter: ReturnType<typeof appendNormalizedToTailBuffer> | null,
  ptyNormalized: ReturnType<typeof normalizeTerminalChunk> | null,
  data: string,
  at: number
): void {
  if (
    pty &&
    ptyTailBefore &&
    ptyTailAfter &&
    tailStateMatches(
      leaf.tailBuffer,
      leaf.tailTranscriptBuffer,
      leaf.tailPartialLine,
      leaf.tailPendingAnsi,
      leaf.tailRedrawCursor,
      leaf.tailTruncated,
      leaf.tailLinesTotal,
      ptyTailBefore
    )
  ) {
    // Why: the leaf and PTY record usually mirror the same terminal. Reuse
    // the PTY tail update instead of splitting large output twice.
    leaf.tailBuffer = pty.tailBuffer
    leaf.tailTranscriptBuffer = pty.tailTranscriptBuffer
    leaf.tailTranscriptChars = pty.tailTranscriptChars
    leaf.tailPartialLine = pty.tailPartialLine
    leaf.tailPartialOrigins = pty.tailPartialOrigins
    leaf.tailPendingOrigins = pty.tailPendingOrigins
    leaf.tailPendingAnsi = pty.tailPendingAnsi
    leaf.tailRedrawCursor = pty.tailRedrawCursor
    leaf.tailTruncated = pty.tailTruncated
    leaf.tailLinesTotal = pty.tailLinesTotal
    leaf.preview = pty.preview
    leaf.waitBlockedAt = pty.waitBlockedAt
    // The PTY wait scan is throttled; copying undefined invalidates the leaf cache for exact recomputation next chunk.
    leaf.tailWaitState = pty.tailWaitState
  } else {
    // Why: the same carried escape prefix normalizes the same chunk identically.
    const normalized =
      ptyNormalized && ptyTailBefore?.pendingAnsi === leaf.tailPendingAnsi
        ? ptyNormalized
        : normalizeTerminalChunk(data, leaf.tailPendingAnsi, {
            chunk: pty?.commandPaint?.chunkOrigins(data.length) ?? [],
            pending: leaf.tailPendingOrigins
          })
    leaf.tailPendingAnsi = normalized.pendingAnsi
    leaf.tailPendingOrigins = normalized.pendingOrigins
    const previousWaitState =
      leaf.tailWaitState?.fromTail === true
        ? leaf.tailWaitState
        : computeTerminalTailWaitState(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview, {
            tailBuffer: leaf.tailBuffer,
            tailPartialLine: leaf.tailPartialLine,
            tailPartialOrigins: leaf.tailPartialOrigins,
            preview: leaf.preview,
            commandPaint: pty?.commandPaint
          })
    const nextTail = appendNormalizedToTailBuffer(
      leaf.tailBuffer,
      leaf.tailPartialLine,
      normalized.text,
      leaf.tailRedrawCursor,
      { partial: leaf.tailPartialOrigins ?? [], chunk: normalized.origins ?? [] }
    )
    const nextTranscript = appendCompletedTerminalTranscript(
      leaf.tailTranscriptBuffer,
      leaf.tailTranscriptChars,
      nextTail.newlyCompletedLines,
      nextTail.newCompleteLines
    )
    const nextWaitState = computeTerminalTailWaitState(
      nextTail.lines,
      nextTail.partialLine,
      leaf.preview,
      {
        tailBuffer: nextTail.lines,
        tailPartialLine: nextTail.partialLine,
        tailPartialOrigins: nextTail.partialOrigins,
        preview: leaf.preview,
        commandPaint: pty?.commandPaint
      }
    )
    if (
      tailGainedNewerBlockedReason(
        previousWaitState,
        nextWaitState,
        normalized.text,
        normalized.origins,
        pty?.commandPaint?.contentOrigin
      )
    ) {
      leaf.waitBlockedAt = at
    }
    leaf.tailWaitState = nextWaitState
    leaf.tailBuffer = nextTail.lines
    leaf.tailTranscriptBuffer = nextTranscript.lines
    leaf.tailTranscriptChars = nextTranscript.characters
    leaf.tailPartialLine = nextTail.partialLine
    leaf.tailPartialOrigins = nextTail.partialOrigins
    leaf.tailRedrawCursor = nextTail.redrawCursor
    leaf.tailTruncated = leaf.tailTruncated || nextTail.truncated || nextTranscript.truncated
    leaf.tailLinesTotal += nextTail.newCompleteLines
    leaf.preview = buildPreview(leaf.tailBuffer, leaf.tailPartialLine)
  }
}
