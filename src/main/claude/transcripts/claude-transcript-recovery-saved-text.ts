import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from '../../native-chat/agent-session-journal/context-epochs/journal-epoch-replacement'
import { digestPayload } from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type { JournalHistoryItem } from '../../native-chat/agent-session-journal/journal-history-items'

const ITEMS_PER_READ = 32
const MARKER = /\n\[Orca: output truncated — (\d+) bytes total, digest ([0-9a-f]{12})\]$/

function clippedText(block: NativeChatBlock): string | undefined {
  return block.type === 'text'
    ? block.text
    : block.type === 'tool-result'
      ? block.output
      : undefined
}

// Whole texts a saved row holds: message blocks, and a tool call's output unless it was clipped.
function savedTexts(body: AgentJournalItemBody | undefined): string[] {
  if (body?.kind === 'message') {
    return body.blocks.flatMap((block) => {
      const text = clippedText(block)
      return text === undefined ? [] : [text]
    })
  }
  return body?.kind === 'tool-call' && body.output && !body.output.truncated
    ? [body.output.head]
    : []
}

// The marker names the whole text's size and digest, so only a provably equal saved text restores it.
function restoredBlock(block: NativeChatBlock, saved: readonly string[]): NativeChatBlock {
  const marker = MARKER.exec(clippedText(block) ?? '')
  if (!marker) {
    return block
  }
  const text = saved.find(
    (candidate) =>
      Buffer.byteLength(candidate, 'utf8') === Number(marker[1]) &&
      digestPayload(candidate).startsWith(marker[2]!)
  )
  if (text === undefined) {
    return block
  }
  return block.type === 'text'
    ? { ...block, text }
    : block.type === 'tool-result'
      ? { ...block, output: text }
      : block
}

/**
 * Recovery imports clip long text, but the chat may already hold those turns whole. Keep the
 * saved text where it is provably the same, so a replacement never shortens what Orca saved.
 */
export async function keepSavedRecoveryText(
  items: readonly JournalReplacementItem[],
  savedKeys: readonly (readonly string[])[] | undefined,
  reads: { historyItems(itemIds: readonly string[]): Promise<readonly JournalHistoryItem[]> },
  check: () => void
): Promise<{ items: JournalReplacementItem[]; addedBytes: number }> {
  const result = [...items]
  let addedBytes = 0
  const clipped = items.flatMap((item, index) =>
    item.body.kind === 'message' &&
    item.body.blocks.some((block) => MARKER.test(clippedText(block) ?? ''))
      ? [index]
      : []
  )
  for (let start = 0; start < clipped.length; start += ITEMS_PER_READ) {
    check()
    const indexes = clipped.slice(start, start + ITEMS_PER_READ)
    // A streamed turn is saved per block and per tool call, not under its record's id.
    const keysOf = (index: number) => [
      agentJournalItemKey(items[index]!.identity),
      ...(savedKeys?.[index] ?? [])
    ]
    let saved: readonly JournalHistoryItem[]
    try {
      saved = await reads.historyItems([...new Set(indexes.flatMap(keysOf))])
    } catch {
      // A read too large to answer leaves these turns as imported.
      continue
    }
    check()
    const byKey = new Map(saved.map((entry) => [entry.key, entry]))
    for (const index of indexes) {
      const item = items[index]!
      const imported = item.body
      if (imported.kind !== 'message') {
        continue
      }
      const texts = keysOf(index).flatMap((key) => {
        const entry = byKey.get(key)
        return entry && !entry.removed ? savedTexts(entry.item?.body) : []
      })
      const blocks = imported.blocks.map((block) => restoredBlock(block, texts))
      if (blocks.some((block, at) => block !== imported.blocks[at])) {
        const body = { ...imported, blocks }
        addedBytes +=
          Buffer.byteLength(JSON.stringify(body)) - Buffer.byteLength(JSON.stringify(item.body))
        result[index] = { ...item, body }
      }
    }
  }
  return { items: result, addedBytes }
}
