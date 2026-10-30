import type { NativeChatLineDecoder } from './transcript-tail-reader'
import {
  readIncrementalTranscriptMessages,
  type createIncrementalTranscriptState
} from './transcript-incremental-reader'

export async function readTranscriptQuestionCapture(
  filePath: string,
  state: ReturnType<typeof createIncrementalTranscriptState>,
  decode: NativeChatLineDecoder,
  append: (messages: Awaited<ReturnType<typeof readIncrementalTranscriptMessages>>) => void,
  signal: AbortSignal,
  endExclusive: number,
  qualifyFrontier: () => Promise<void>,
  quarantine: () => void
): Promise<void> {
  let safeIo = false
  try {
    append(
      await readIncrementalTranscriptMessages(
        filePath,
        state,
        decode,
        append,
        undefined,
        undefined,
        signal,
        true,
        {
          endExclusive,
          onFailure: (safe) => {
            safeIo = safe
          }
        }
      )
    )
  } catch (error) {
    if (safeIo) {
      try {
        await qualifyFrontier()
      } catch {
        quarantine()
      }
    } else {
      quarantine()
    }
    throw error
  }
}
