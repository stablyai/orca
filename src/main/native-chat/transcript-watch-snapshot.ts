import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import type { IncrementalTranscriptState } from './transcript-incremental-reader'

export function createTranscriptWatchSnapshotReader(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  decodeLifecycle: ((line: string, fallbackId: string) => NativeChatTurnLifecycle | null) | null,
  signal: AbortSignal,
  sourceOrder: boolean | undefined,
  state: IncrementalTranscriptState
) {
  return (limit: number) =>
    readNativeChatTranscriptTailFile(
      filePath,
      limit,
      decode,
      false,
      undefined,
      decodeLifecycle,
      signal,
      (boundary) => {
        state.boundary = boundary
      },
      sourceOrder
    )
}

export function adoptTranscriptWatchSnapshot(
  state: IncrementalTranscriptState,
  snapshot: Awaited<ReturnType<typeof readNativeChatTranscriptTailFile>>
): void {
  state.offset = snapshot.consumedTo
  state.pendingStart = state.offset
  state.latestTimestamp = snapshot.latestTimestamp ?? Number.NEGATIVE_INFINITY
}
