import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Decides whether the live streaming preview should render as a synthetic
 *  bubble. Text alone can't tell "the transcript caught up with this stream"
 *  from "a new reply happens to repeat the previous turn's prefix" — the old
 *  prefix test swallowed genuine repeated-prefix replies. The gate keeps the
 *  transcript tail observed when the current stream segment began: the bubble
 *  hides only when the tail MOVED during the segment and leads with the
 *  streamed text (the real turn landed), never for an older identical turn. */
export type MobileNativeChatStreamingGate = {
  /** Chat/session identity this baseline belongs to. */
  scopeKey: string | null
  /** Streamed text seen on the previous tick ('' while idle). */
  prevText: string
  /** Folded tail message id when the current segment began; null while the
   *  gate has never observed a transcript tail (text arrived on its very first
   *  tick), where the legacy suppress-on-prefix rule applies. */
  baselineTailId: string | null
}

/** The preview text to feed the gate for one tick, or undefined for "no observation".
 *
 *  Providers publish a tool's stdout/error as `lastAssistantMessage` so status cards can
 *  preview it. That text is not the reply and never lands in a transcript assistant block,
 *  so the catch-up rule below could never retire it — it stayed on screen as a wall of raw
 *  tool output until the turn ended. Treating it as no observation (rather than empty text
 *  that still anchors) also keeps it out of `prevText`, so the next real reply is not
 *  mistaken for a continuation of a tool result. */
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

function assistantTailText(tail: NativeChatMessage | undefined): string {
  if (!tail || tail.role !== 'assistant') {
    return ''
  }
  return tail.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

// Reuses the incoming gate object when nothing moved, so a caller can detect
// "no change" by reference (and a render-time state adjustment can settle).
function advanceGate(
  gate: MobileNativeChatStreamingGate,
  prevText: string,
  baselineTailId: string | null
): MobileNativeChatStreamingGate {
  return gate.prevText === prevText && gate.baselineTailId === baselineTailId
    ? gate
    : { ...gate, prevText, baselineTailId }
}

/** Advance the gate one tick and derive the visible streaming text (null hides
 *  the bubble). Pure and idempotent for a repeated (text, tail) pair, so a
 *  re-render without new data cannot flip the decision. */
export function deriveMobileNativeChatStreaming(
  gate: MobileNativeChatStreamingGate,
  folded: readonly NativeChatMessage[],
  streamingText: string | undefined,
  options: {
    scopeKey?: string | null
    /** Whether the agent is still mid-turn. A textless tick then means "no
     *  observation this render", not "the stream ended". */
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
    // Only a textless tick that carries a real tail and is outside a live turn
    // is trustworthy pre-stream history. Mid-turn gaps (a tool call, a throttle
    // lull, the transcript landing the reply before its status text) would
    // otherwise adopt that reply as history and render it a second time as a
    // bubble; a torn-down transcript carries no tail at all. The exception is a
    // gate that has never anchored — mounted mid-turn, the first real tail it
    // sees is the best pre-stream history it will ever get.
    const canAnchor = tailId !== null && (!options.streamLive || scopedGate.baselineTailId === null)
    return { gate: canAnchor ? advanceGate(scopedGate, '', tailId) : scopedGate, streaming: null }
  }
  // A stream that is not an extension of the previous tick is a new segment
  // (next reply part); re-anchor to the tail that predates it.
  const segmentStart = scopedGate.prevText !== '' && !text.startsWith(scopedGate.prevText)
  const baselineTailId = segmentStart ? tailId : scopedGate.baselineTailId
  const tailLeadsWithStream = assistantTailText(tail).startsWith(text)
  // A null baseline (text on the very first tick, no tail ever seen) is unequal
  // to every real tail id, so this degrades to the legacy suppress-on-prefix rule.
  const caughtUp = tailLeadsWithStream && tailId !== baselineTailId
  return {
    gate: advanceGate(scopedGate, text, baselineTailId),
    streaming: caughtUp ? null : text
  }
}
