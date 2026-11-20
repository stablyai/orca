import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

type Entry = {
  row: Record<string, unknown>
  item?: JournalReplacementItem
  bytes: number
  chainBytes: number
}

const MAX_LINK_BYTES = 1024 * 1024
const MAX_ITEM_CHAIN_BYTES = 64 * 1024 * 1024

export function createClaudeImportWindow(maxItemBytes: number, newestFirst: boolean) {
  const entries = new Set<Entry>()
  const items = new Set<Entry>()
  const links = new Set<Entry>()
  let itemBytes = 0
  let linkBytes = 0
  let itemChainBytes = 0
  let itemsFull = false
  return {
    keep(row: Record<string, unknown>, item?: JournalReplacementItem) {
      if (!item && (typeof row.uuid !== 'string' || !row.uuid)) {
        return
      }
      if (item && itemsFull) {
        return
      }
      const link = {
        uuid: typeof row.uuid === 'string' ? row.uuid : undefined,
        parentUuid: typeof row.parentUuid === 'string' ? row.parentUuid : null,
        logicalParentUuid: typeof row.logicalParentUuid === 'string' ? row.logicalParentUuid : null,
        type: typeof row.type === 'string' ? row.type : undefined
      }
      const message = claudeRecord(row.message)
      const content: Record<string, unknown>[] = []
      if (item && Array.isArray(message?.content)) {
        for (const value of message.content) {
          const part = claudeRecord(value)
          if (part?.type === 'tool_use' && typeof part.id === 'string') {
            content.push({ type: part.type, id: part.id })
          } else if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
            content.push({ type: part.type, tool_use_id: part.tool_use_id })
          }
        }
      }
      const id = typeof message?.id === 'string' ? message.id : undefined
      const chainRow = item ? { ...link, message: { id, content } } : link
      const chainBytes = Buffer.byteLength(JSON.stringify(chainRow))
      const bytes = item ? Buffer.byteLength(JSON.stringify(item)) : chainBytes
      const entry = { row: chainRow, item, bytes, chainBytes }
      const category = item ? items : links
      const budget = item ? maxItemBytes : MAX_LINK_BYTES
      const chainFull = item !== undefined && itemChainBytes + chainBytes > MAX_ITEM_CHAIN_BYTES
      if (
        newestFirst &&
        ((item ? itemBytes : linkBytes) + bytes > budget || chainFull) &&
        category.size > 0
      ) {
        itemsFull ||= item !== undefined
        return
      }
      entries.add(entry)
      category.add(entry)
      if (item) {
        itemBytes += bytes
        itemChainBytes += chainBytes
      } else {
        linkBytes += bytes
      }
      while (
        ((item ? itemBytes : linkBytes) > budget ||
          (item && itemChainBytes > MAX_ITEM_CHAIN_BYTES)) &&
        category.size > (item ? 1 : 0)
      ) {
        const oldest = category.values().next().value!
        category.delete(oldest)
        entries.delete(oldest)
        if (item) {
          itemBytes -= oldest.bytes
          itemChainBytes -= oldest.chainBytes
        } else {
          linkBytes -= oldest.bytes
        }
      }
    },
    entries: () => (newestFirst ? [...entries].toReversed() : entries)
  }
}
