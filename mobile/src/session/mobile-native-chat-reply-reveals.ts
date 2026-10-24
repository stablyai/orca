import { createContext, useMemo, useState } from 'react'
import { NATIVE_CHAT_STREAMING_ID } from '../../../src/shared/native-chat-streaming'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  createNativeChatReplyRevealTracker,
  trackNativeChatReplyRows,
  type NativeChatReplyReveals
} from '../../../src/shared/native-chat-reply-reveals'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'

/** One chat's reveals, held above its list so a row the list remounts, or a chat reopened from
 *  the terminal, resumes instead of replaying. */
export type MobileNativeChatReplyReveals = NativeChatReplyReveals & { reducedMotion: boolean }

/** Absent outside a chat: text draws as it arrives. */
export const MobileNativeChatReplyRevealsContext =
  createContext<MobileNativeChatReplyReveals | null>(null)

export function useMobileNativeChatReplyReveals(
  folded: readonly NativeChatMessage[],
  streaming: boolean,
  scopeKey: string
): MobileNativeChatReplyReveals {
  const [held] = useState(() => ({ scopeKey, tracker: createNativeChatReplyRevealTracker() }))
  // Row keys are only unique within one chat, so another chat starts its own.
  if (held.scopeKey !== scopeKey) {
    held.scopeKey = scopeKey
    held.tracker = createNativeChatReplyRevealTracker()
  }
  // Once per transcript change, not per streamed chunk.
  const rowKeys = useMemo(() => {
    const keys = folded.map((message) => message.id)
    return streaming ? [...keys, NATIVE_CHAT_STREAMING_ID] : keys
  }, [folded, streaming])
  const loaded = useMemo(() => new Set(rowKeys), [rowKeys])
  const reveals = trackNativeChatReplyRows(held.tracker, rowKeys, loaded)
  // Until the OS answers, text draws as it arrives.
  const reducedMotion = useReducedMotionEnabled() !== false
  return useMemo(() => ({ ...reveals, reducedMotion }), [reveals, reducedMotion])
}
