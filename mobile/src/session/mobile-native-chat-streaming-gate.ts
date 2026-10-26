import { latestNativeChatReplyText } from '../../../src/shared/native-chat/native-chat-streaming'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

// Compare prefixes only after the segment’s captured tail so a previous turn’s identical reply cannot swallow a new preview.
export type MobileNativeChatStreamingGate = {
  scopeKey: string | null
  prevText: string
  // Null means no tail was observed before streaming; only then fall back to suppressing any matching prefix.
  baselineTailId: string | null
}

// Tool output never lands as assistant text; treat it as unobserved so it cannot persist as a reply or become the next segment’s baseline.
export function mobileNativeChatStreamPreview(
  status:
    | { lastAssistantMessage?: string; lastAssistantMessageIsToolOutput?: boolean }
    | null
    | undefined,
  working: boolean
): string | undefined {
  if (!working || status?.lastAssistantMessageIsToolOutput === true) {
    return undefined
  }
  return status?.lastAssistantMessage
}

export function createMobileNativeChatStreamingGate(
  scopeKey: string | null = null
): MobileNativeChatStreamingGate {
  return { scopeKey, prevText: '', baselineTailId: null }
}

// Reuse unchanged gates so render-time state adjustments settle by reference.
function advanceGate(
  gate: MobileNativeChatStreamingGate,
  prevText: string,
  baselineTailId: string | null
): MobileNativeChatStreamingGate {
  return gate.prevText === prevText && gate.baselineTailId === baselineTailId
    ? gate
    : { ...gate, prevText, baselineTailId }
}

// Repeated text/tail observations must keep the same decision across re-renders.
export function deriveMobileNativeChatStreaming(
  gate: MobileNativeChatStreamingGate,
  folded: readonly NativeChatMessage[],
  streamingText: string | undefined,
  options: {
    scopeKey?: string | null
    // Textless ticks during a live turn are missing observations, not stream endings.
    streamLive?: boolean
  } = {}
): { gate: MobileNativeChatStreamingGate; streaming: string | null } {
  const scopeKey = options.scopeKey === undefined ? gate.scopeKey : options.scopeKey
  const scopedGate =
    gate.scopeKey === scopeKey ? gate : createMobileNativeChatStreamingGate(scopeKey)
  const text = streamingText?.trim() ?? ''
  const tail = folded.at(-1)
  const tailId = tail?.id ?? null
  if (!text) {
    // Anchor only settled real history, except on first mount: live gaps may already contain the reply and would duplicate it as a preview.
    const canAnchor = tailId !== null && (!options.streamLive || scopedGate.baselineTailId === null)
    return { gate: canAnchor ? advanceGate(scopedGate, '', tailId) : scopedGate, streaming: null }
  }
  // A non-extension begins a new segment with the current tail as its baseline.
  const segmentStart = scopedGate.prevText !== '' && !text.startsWith(scopedGate.prevText)
  const baselineTailId = segmentStart ? tailId : scopedGate.baselineTailId
  // Only post-baseline replies can retire this segment; a missing baseline falls back to scanning the whole turn.
  const baselineIndex =
    baselineTailId === null ? -1 : folded.findIndex((message) => message.id === baselineTailId)
  const caughtUp = latestNativeChatReplyText(folded, baselineIndex).startsWith(text)
  return {
    gate: advanceGate(scopedGate, text, baselineTailId),
    streaming: caughtUp ? null : text
  }
}
