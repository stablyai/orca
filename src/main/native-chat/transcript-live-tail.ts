import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat/native-chat-types'
import { appendNativeChatChildTranscripts } from './transcript-subagent-children'
import {
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import type { NativeChatTurnLifecycleDecoder } from './transcript-turn-lifecycle'

type LiveTailPage = {
  messages: NativeChatMessage[]
  lifecycle?: NativeChatTurnLifecycle
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
  latestTimestamp?: number
  malformedRecordCount?: number
  oversizedRecordCount?: number
}

/** Parent handle is closed before child files open. Nesting those reads deadlocks the scan slot. */
export async function readNativeChatLiveTail(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  includeTrailingLine = false,
  endOffset?: number,
  decodeLifecycle?: NativeChatTurnLifecycleDecoder | null,
  signal?: AbortSignal,
  onConsumedBoundary?: (boundary: Buffer) => void,
  sourceOrder = false
): Promise<LiveTailPage> {
  const page = await readNativeChatTranscriptTailFile(
    filePath,
    limit,
    decode,
    includeTrailingLine,
    endOffset,
    decodeLifecycle,
    signal,
    onConsumedBoundary,
    sourceOrder
  )
  if (endOffset !== undefined || limit <= 0) {
    return page
  }
  const messages = await appendNativeChatChildTranscripts(filePath, decode, page.messages, signal)
  return messages.length === page.messages.length ? page : { ...page, messages }
}
