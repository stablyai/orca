import { useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  createMobileNativeChatStreamingGate,
  deriveMobileNativeChatStreaming
} from './mobile-native-chat-streaming-gate'

/** Live streaming-bubble text for the chat list. The gate remembers which
 *  transcript tail predates the current stream segment, so a reply that repeats
 *  the previous turn's prefix still shows while streaming. Call this from a
 *  component that outlives the chat list itself: the baseline has to survive the
 *  view toggles that unmount it, or the next segment reverts to prefix-matching.
 *  `streamLive` keeps those textless gaps from reading as an idle stream. */
export function useMobileNativeChatStreamingBubble(
  folded: readonly NativeChatMessage[],
  streamingText: string | undefined,
  scopeKey: string,
  streamLive: boolean
): string | null {
  const [gate, setGate] = useState(() => createMobileNativeChatStreamingGate(scopeKey))
  const step = deriveMobileNativeChatStreaming(gate, folded, streamingText, {
    scopeKey,
    streamLive
  })
  if (step.gate !== gate) {
    // Render-time state adjustment (derived-state pattern): the advance is
    // idempotent for a repeated (text, tail) pair, so this settles in one pass.
    setGate(step.gate)
  }
  return step.streaming
}
