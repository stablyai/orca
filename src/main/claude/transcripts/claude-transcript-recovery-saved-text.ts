import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from '../../native-chat/agent-session-journal/context-epochs/journal-epoch-replacement'
import { digestPayload } from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type { JournalHistoryItem } from '../../native-chat/agent-session-journal/journal-history-items'

const KEYS_PER_READ = 64
const MARKER = /\n\[Orca: output truncated — (\d+) bytes total, digest ([0-9a-f]{12})\]$/

function clippedText(block: NativeChatBlock): string | undefined {
  return block.type === 'text'
    ? block.text
    : block.type === 'tool-result'
      ? block.output
      : undefined
}

// The marker names the whole text's size and digest, so a saved block restores it only if equal.
function savedBlock(imported: NativeChatBlock, saved: NativeChatBlock | undefined) {
  const marker = MARKER.exec(clippedText(imported) ?? '')
  const text = saved && saved.type === imported.type ? clippedText(saved) : undefined
  return marker &&
    text !== undefined &&
    Buffer.byteLength(text, 'utf8') === Number(marker[1]) &&
    digestPayload(text).startsWith(marker[2]!)
    ? saved
    : undefined
}

function restoredBody(
  imported: AgentJournalItemBody,
  saved: AgentJournalItemBody | undefined
): AgentJournalItemBody | undefined {
  if (imported.kind !== 'message' || saved?.kind !== 'message' || saved.role !== imported.role) {
    return undefined
  }
  let restored = false
  const blocks = imported.blocks.map((block, index) => {
    const kept = savedBlock(block, saved.blocks[index])
    restored ||= kept !== undefined
    return kept ?? block
  })
  return restored ? { ...imported, blocks } : undefined
}

/**
 * Recovery imports clip long text, but the chat may already hold those turns whole. Keep the
 * saved text where it is provably the same, so a replacement never shortens what Orca saved.
 */
export async function keepSavedRecoveryText(
  items: readonly JournalReplacementItem[],
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
  for (let start = 0; start < clipped.length; start += KEYS_PER_READ) {
    check()
    const indexes = clipped.slice(start, start + KEYS_PER_READ)
    const keys = indexes.map((index) => agentJournalItemKey(items[index]!.identity))
    let saved: readonly JournalHistoryItem[]
    try {
      saved = await reads.historyItems(keys)
    } catch {
      // A read too large to answer leaves these turns as imported.
      continue
    }
    check()
    const byKey = new Map(saved.map((entry) => [entry.key, entry]))
    for (const [offset, index] of indexes.entries()) {
      const entry = byKey.get(keys[offset]!)
      const item = items[index]!
      const body = restoredBody(item.body, entry && !entry.removed ? entry.item?.body : undefined)
      if (body) {
        addedBytes +=
          Buffer.byteLength(JSON.stringify(body)) - Buffer.byteLength(JSON.stringify(item.body))
        result[index] = { ...item, body }
      }
    }
  }
  return { items: result, addedBytes }
}
