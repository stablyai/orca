import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  boundMessage,
  MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES,
  WIRE_SIZE_CLIPPED_WARNING,
  type TranscriptBoundState
} from './worker-transcript-payload'

/** Apply message bounds newest-first for archives; forward-page head bounds would lose the worker's final answer. */
export function boundWorkerTranscriptTail(
  messages: readonly NativeChatMessage[],
  maxBytes: number
): { messages: NativeChatMessage[]; limited: boolean; warnings: string[] } {
  const tail = boundNewestFirst(messages, maxBytes, undefined)
  return { messages: tail.messages, limited: tail.cut, warnings: tail.warnings }
}

/** A first page is the transcript's newest messages, so the byte budget drops its oldest, never the latest work. */
export function boundWorkerTranscriptNewest(
  messages: readonly NativeChatMessage[],
  transcriptPath: string
): {
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
  /** Indexes of kept messages whose blocks or text were cut. */
  shortened: number[]
} {
  const tail = boundNewestFirst(messages, MAX_WORKER_TRANSCRIPT_RESPONSE_BYTES, transcriptPath)
  return {
    messages: tail.messages,
    limited: tail.cut || tail.clipped,
    warnings: tail.cut
      ? [...new Set([...tail.warnings, WIRE_SIZE_CLIPPED_WARNING])]
      : tail.warnings,
    shortened: tail.shortened
  }
}

function boundNewestFirst(
  messages: readonly NativeChatMessage[],
  maxBytes: number,
  transcriptPath: string | undefined
): {
  messages: NativeChatMessage[]
  cut: boolean
  clipped: boolean
  warnings: string[]
  shortened: number[]
} {
  const state: TranscriptBoundState = { warnings: new Set<string>(), clipped: false }
  const keptReversed: NativeChatMessage[] = []
  const shortenedReversed: boolean[] = []
  let bytes = 2
  let cut = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    state.shownContentCut = false
    const next = boundMessage(messages[index]!, transcriptPath, state)
    const serializedBytes = Buffer.byteLength(JSON.stringify(next), 'utf8') + 1
    if (keptReversed.length > 0 && bytes + serializedBytes > maxBytes) {
      cut = true
      break
    }
    keptReversed.push(next)
    shortenedReversed.push(state.shownContentCut)
    bytes += serializedBytes
  }
  keptReversed.reverse()
  const shortened = shortenedReversed
    .toReversed()
    .flatMap((wasCut, index) => (wasCut ? [index] : []))
  return {
    messages: keptReversed,
    cut,
    clipped: state.clipped,
    warnings: [...state.warnings],
    shortened
  }
}
