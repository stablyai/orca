import { useState } from 'react'
import type { NativeChatMessage } from '../../../../src/shared/native-chat-types'
import {
  createMobileNativeChatStreamingGate,
  deriveMobileNativeChatStreaming
} from './mobile-native-chat-streaming-gate'

// Keep the segment baseline above list remounts so view toggles preserve repeated-prefix previews; streamLive distinguishes hidden gaps from turn end.
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
    // Idempotent derived-state adjustment settles after one render for repeated text/tail.
    setGate(step.gate)
  }
  return step.streaming
}
