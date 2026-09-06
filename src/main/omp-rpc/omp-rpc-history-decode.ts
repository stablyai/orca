// Decodes an RPC history page into renderable chat messages.
//
// `get_messages_page` returns bare `AgentMessage` values — the *inner* value of
// an on-disk `SessionMessageEntry`, with no envelope id and a numeric
// timestamp. Rather than grow a second omp decoder that would drift from the
// transcript one (reasoning split, execution cells, fileMention, the
// display-gated extension turns), each message is wrapped back into the
// envelope `decodeOmpTranscriptLine` already understands and handed to it. The
// result is shaped exactly like a transcript row, which is what lets the
// assembler's existing cross-source dedupe rank the two against each other.

import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { OmpRpcHistoryMessage } from '../../shared/omp-rpc-protocol'
import { decodeOmpTranscriptLine } from '../native-chat/transcript-line-decoders-omp'

/** Prefix of every synthesized history id. Positional, not wire-derived —
 *  see the module note on why no wire id exists to use instead. */
export const OMP_RPC_HISTORY_ID_PREFIX = 'omp-rpc-history-'

/**
 * Decodes one page-drained history snapshot. Ids are the message's index in the
 * snapshot, so re-hydrating the same unchanged history yields the same ids and
 * the renderer's dedupe sees one turn rather than two. Records the decoder
 * refuses are dropped without renumbering, for the same reason.
 */
export function decodeOmpRpcHistoryMessages(
  messages: readonly OmpRpcHistoryMessage[]
): NativeChatMessage[] {
  const decoded: NativeChatMessage[] = []
  for (const [index, message] of messages.entries()) {
    const id = `${OMP_RPC_HISTORY_ID_PREFIX}${index}`
    const line = JSON.stringify({
      type: 'message',
      id,
      parentId: null,
      ...timestampField(message),
      message
    })
    const result = decodeOmpTranscriptLine(line, id)
    if (!result) {
      continue
    }
    for (const entry of Array.isArray(result) ? result : [result]) {
      decoded.push({ ...entry, source: 'rpc' })
    }
  }
  return decoded
}

/** Lifts the message's own epoch-ms clock into the envelope slot the transcript
 *  decoder reads. Omitted when absent so the decoder yields a null timestamp
 *  rather than inventing one. */
function timestampField(message: OmpRpcHistoryMessage): { timestamp?: unknown } {
  return message.timestamp === undefined ? {} : { timestamp: message.timestamp }
}
