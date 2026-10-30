import type {
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { isInterruptedStatusMessage } from '../../../shared/native-chat-types'
import { isNativeChatContextClear } from '../../../shared/agent-session-context-clear'
import {
  isDeliveredNativeChatUserMessage,
  parseAskFromToolInput
} from '../../../shared/native-chat/input/native-chat-ask'
import { digestPayload } from '../agent-session-journal/journal-payload-bounds'

export type Boundary = {
  prefix: { message: NativeChatMessage; order: readonly [number, number] }[]
  full: ReadonlyMap<string, NativeChatMessage>
}

export function createQuestionImportFold(
  imported: readonly AgentJournalRenderItem[],
  removed: ReadonlyMap<string, number>,
  signal: AbortSignal
) {
  const retained = new Map(imported.map((item) => [item.itemId, item]))
  const last = imported.at(-1)!.itemId
  const prefix: Boundary['prefix'] = []
  const full = new Map<string, NativeChatMessage>()
  let seenRetained = false
  let boundaryFound = false
  const accept = (
    message: NativeChatMessage,
    identity: AgentJournalItemIdentity,
    sourceOrder: number
  ): void => {
    if (boundaryFound) {
      return
    }
    signal.throwIfAborted()
    const itemId = agentJournalItemKey(identity)
    const saved = retained.get(itemId)
    if (saved) {
      seenRetained = true
      const calls =
        saved.body.kind === 'tool-call'
          ? [{ type: 'tool-call' as const, input: saved.body.input }]
          : saved.body.kind === 'message'
            ? saved.body.blocks.filter((block) => block.type === 'tool-call')
            : []
      const originals = message.blocks.filter((block) => block.type === 'tool-call')
      for (const [index, call] of calls.entries()) {
        if (isClippedInput(call.input)) {
          const original = originals[index]
          if (
            !original ||
            digestPayload(JSON.stringify(original.input) ?? 'null') !== call.input.digest
          ) {
            throw new Error('Original question definition does not match saved import')
          }
        }
      }
      if (originals.length) {
        full.set(itemId, { ...message, id: itemId })
      }
    } else if (!seenRetained && !removed.has(itemId)) {
      const blocks = message.blocks.filter(
        (block) =>
          block.type === 'tool-call' &&
          parseAskFromToolInput(block.name, block.input)?.replyAsMessage
      )
      if (
        blocks.length ||
        isDeliveredNativeChatUserMessage(message) ||
        isInterruptedStatusMessage(message) ||
        isNativeChatContextClear(message)
      ) {
        prefix.push({
          message: { ...message, id: itemId, blocks: message.blocks },
          order: [-1, sourceOrder]
        })
      }
    }
    if (itemId === last) {
      boundaryFound = true
    }
  }
  return { accept, boundaryFound: () => boundaryFound, result: { prefix, full } }
}

function isClippedInput(value: unknown): value is { truncated: true; digest: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'truncated' in value &&
    value.truncated === true &&
    'digest' in value &&
    typeof value.digest === 'string'
  )
}

/** Only the digest-proven clipped value is replaced; later canonical edits stay authoritative. */
export function restoreImportedQuestionMessage(
  message: NativeChatMessage,
  original: NativeChatMessage | undefined
): NativeChatMessage {
  if (!original) {
    return message
  }
  const calls = original.blocks.filter((block) => block.type === 'tool-call')
  let index = 0
  return {
    ...message,
    timestamp: original.timestamp,
    blocks: message.blocks.map((block) => {
      if (block.type !== 'tool-call') {
        return block
      }
      const full = calls[index++]
      return full && isClippedInput(block.input) ? { ...block, input: full.input } : block
    })
  }
}
