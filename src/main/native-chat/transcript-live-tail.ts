import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat/native-chat-types'
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
  return page
}
