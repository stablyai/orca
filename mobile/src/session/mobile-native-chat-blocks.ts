import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatMessage,
  NativeChatSource,
  NativeChatTextBlock,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../src/shared/native-chat-types'

// Why: the mobile bundle can only `import type` from the repo's src/shared —
// Metro doesn't watch outside the mobile package, so runtime values imported
// from there fail to resolve. These mirror the values in native-chat-types.ts
// (source precedence + block guards); keep them in sync with that file.

/** Source precedence — higher wins when two sources describe the same turn.
 *  Mirrors NATIVE_CHAT_SOURCE_PRIORITY in src/shared/native-chat-types.ts. */
export const NATIVE_CHAT_SOURCE_PRIORITY: Record<NativeChatSource, number> = {
  transcript: 3,
  hook: 2,
  scrape: 1
}

export function isTextBlock(block: NativeChatBlock): block is NativeChatTextBlock {
  return block.type === 'text'
}

export function isToolCallBlock(block: NativeChatBlock): block is NativeChatToolCallBlock {
  return block.type === 'tool-call'
}

export function isToolResultBlock(block: NativeChatBlock): block is NativeChatToolResultBlock {
  return block.type === 'tool-result'
}

export function isImageRefBlock(block: NativeChatBlock): block is NativeChatImageRefBlock {
  return block.type === 'image-ref'
}

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
 *  block. A result attaches to the most recent unmatched call; an orphan result
 *  (no preceding call) stands on its own. */
export function pairToolBlocks(blocks: readonly NativeChatBlock[], limit = Infinity): ToolPair[] {
  const pairs: ToolPair[] = []
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      if (pairs.length < limit) {
        pairs.push({ call: block })
      }
    } else if (block.type === 'tool-result') {
      const last = pairs[pairs.length - 1]
      if (last && last.call && !last.result) {
        last.result = block
      } else if (pairs.length < limit) {
        pairs.push({ result: block })
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
