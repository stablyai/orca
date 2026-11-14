import { setBoundedScopeCacheEntry } from '../../../../../../src/shared/native-chat/native-chat-scope-cache'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatResumePoint } from '../../../../../../src/shared/rpc-contract/native-chat/native-chat-params'
import { peekStoredChatTranscript } from './mobile-native-chat-transcript-store'

const MAX_CACHED_TRANSCRIPTS = 8

export type MobileNativeChatCachedTranscript = {
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number | null
  // Set while the rows are an earlier launch's stored copy that no read in this page has confirmed.
  savedAt?: number
}

// The first layer, for this page's lifetime; the phone's store (mobile-native-chat-transcript-store) is the second.
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

/** This page's rows for a chat, else the phone's stored copy once read; undefined when neither is held. */
export function heldMobileNativeChatTranscript(
  identity: string
): MobileNativeChatCachedTranscript | undefined {
  const cached = mobileNativeChatTranscriptCache.get(identity)
  if (cached) {
    return cached
  }
  const stored = peekStoredChatTranscript(identity)
  return stored?.kind === 'terminal'
    ? {
        messages: stored.messages,
        hasMore: stored.hasMore,
        beforeOffset: stored.beforeOffset,
        savedAt: stored.savedAt
      }
    : undefined
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
