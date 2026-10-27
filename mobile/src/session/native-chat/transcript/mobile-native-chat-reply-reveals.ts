import { createContext, useMemo, useState } from 'react'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../../src/shared/native-chat/native-chat-streaming'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import {
  createNativeChatReplyRevealTracker,
  trackNativeChatReplyRows,
  type NativeChatReplyReveals
} from '../../../../../src/shared/native-chat-reply-reveals'
import { useReducedMotionEnabled } from '../../../platform/use-reduced-motion'

// Retain reveal state above list remounts/view toggles so replies resume instead of replaying.
export type MobileNativeChatReplyReveals = NativeChatReplyReveals & { reducedMotion: boolean }

export const MobileNativeChatReplyRevealsContext =
  createContext<MobileNativeChatReplyReveals | null>(null)

export function useMobileNativeChatReplyReveals(
  folded: readonly NativeChatMessage[],
  streaming: boolean,
  scopeKey: string
): MobileNativeChatReplyReveals {
  const [held] = useState(() => ({ scopeKey, tracker: createNativeChatReplyRevealTracker() }))
  if (held.scopeKey !== scopeKey) {
    held.scopeKey = scopeKey
    held.tracker = createNativeChatReplyRevealTracker()
  }
  const rowKeys = useMemo(() => {
    const keys = folded.map((message) => message.id)
    return streaming ? [...keys, NATIVE_CHAT_STREAMING_ID] : keys
  }, [folded, streaming])
  const loaded = useMemo(() => new Set(rowKeys), [rowKeys])
  const reveals = trackNativeChatReplyRows(held.tracker, rowKeys, loaded)
  // Default to reduced motion until the OS preference is known.
  const reducedMotion = useReducedMotionEnabled() !== false
  return useMemo(() => ({ ...reveals, reducedMotion }), [reveals, reducedMotion])
}
