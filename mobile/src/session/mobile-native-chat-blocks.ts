import {
  isImageRefBlock,
  isTextBlock,
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../../src/shared/native-chat-types'

// Re-export the block guards and source priority so other mobile modules keep
// importing them from here rather than reaching into src/shared directly.
export { isImageRefBlock, isTextBlock, NATIVE_CHAT_SOURCE_PRIORITY }

function isToolOnlyMessage(message: NativeChatMessage): boolean {
  return (
    message.blocks.length > 0 &&
    message.blocks.every((b) => b.type === 'tool-call' || b.type === 'tool-result')
  )
}

/** Fold a turn's tool activity into the assistant message it belongs to. Claude
 *  emits each tool call as its own assistant message and each result as a
 *  tool-role message; merging every tool-only message into the preceding
 *  assistant turn lets the view collapse a whole turn's tools under one line. */
export function foldToolMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  const out: NativeChatMessage[] = []
  let mutableAssistantIndex = -1
  for (const message of messages) {
    const prev = out[out.length - 1]
    if (isToolOnlyMessage(message) && prev && prev.role === 'assistant') {
      const index = out.length - 1
      if (mutableAssistantIndex !== index) {
        out[index] = { ...prev, blocks: [...prev.blocks] }
        mutableAssistantIndex = index
      }
      out[index].blocks.push(...message.blocks)
    } else {
      out.push(message)
      mutableAssistantIndex = -1
    }
  }
  return out
}

export type ToolPair = {
  call?: NativeChatToolCallBlock
  result?: NativeChatToolResultBlock
}

/** Pair each tool call with its result so a request and its output render as one
 *  block. Blocks carry no tool ids, so calls and results pair by ordinal FIFO —
 *  the Nth result answers the Nth call. Parallel calls batch as
 *  [call, call, result, result], so positional adjacency would misgraft the
 *  first result onto the second call. A call dropped past `limit` still consumes
 *  its result (tracked as a null slot) so the drop never grafts onto a kept
 *  call; a result with no matching call stands on its own. */
export function pairToolBlocks(blocks: readonly NativeChatBlock[], limit = Infinity): ToolPair[] {
  const pairs: ToolPair[] = []
  // Per call ordinal: the pair index it filled, or null when dropped past limit.
  const callSlots: Array<number | null> = []
  let resultOrdinal = 0
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      if (pairs.length < limit) {
        callSlots.push(pairs.length)
        pairs.push({ call: block })
      } else {
        callSlots.push(null)
      }
    } else if (block.type === 'tool-result') {
      const slot = callSlots[resultOrdinal]
      if (slot === undefined) {
        // No call at this ordinal — an orphan result; render it on its own.
        if (pairs.length < limit) {
          pairs.push({ result: block })
        }
      } else {
        resultOrdinal += 1
        if (slot !== null) {
          pairs[slot]!.result = block
        }
      }
    }
  }
  return pairs
}

/** Split a message's blocks into prose (text/image) and tool (call/result), so
 *  the view can render the agent's words first and fold the tool activity into a
 *  separate collapsible run beneath it. */
export function splitNativeChatBlocks(blocks: readonly NativeChatBlock[]): {
  prose: NativeChatBlock[]
  tools: NativeChatBlock[]
} {
  const prose: NativeChatBlock[] = []
  const tools: NativeChatBlock[] = []
  for (const block of blocks) {
    if (block.type === 'tool-call' || block.type === 'tool-result') {
      tools.push(block)
    } else {
      prose.push(block)
    }
  }
  return { prose, tools }
}
