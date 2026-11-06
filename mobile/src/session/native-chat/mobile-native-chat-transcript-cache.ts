import { setBoundedScopeCacheEntry } from '../../../../src/shared/native-chat/native-chat-scope-cache'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatResumePoint } from '../../../../src/shared/rpc-contract/native-chat-params'

const MAX_CACHED_TRANSCRIPTS = 8

type MobileNativeChatCachedTranscript = {
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number | null
}

// Lives as long as the page: the WebView has no durable storage, so a relaunch starts empty.
export const mobileNativeChatTranscriptCache = new Map<string, MobileNativeChatCachedTranscript>()

export function cacheMobileNativeChatTranscript(
  identity: string,
  transcript: MobileNativeChatCachedTranscript
): void {
  setBoundedScopeCacheEntry(
    mobileNativeChatTranscriptCache,
    identity,
    transcript,
    MAX_CACHED_TRANSCRIPTS
  )
}

/** Older hosts send rows with no file offset; those get a normal snapshot. */
export function mobileNativeChatResumePoint(
  messages: readonly NativeChatMessage[]
): NativeChatResumePoint | null {
  const newest = messages.at(-1)
  return newest?.transcriptOrder === undefined
    ? null
    : {
        id: newest.id,
        transcriptOrder: newest.transcriptOrder,
        timestamp: newest.timestamp ?? null
      }
}
