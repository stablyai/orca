import { setImmediate } from 'node:timers/promises'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import { mainChainAsync } from '../../../claude/transcripts/claude-transcript-chain'

// Account for strings, objects, offsets, and the chain walker's temporary indexes.
const MAX_INDEX_BYTES = 128 * 1024 * 1024
const LINK_OVERHEAD_BYTES = 256
const TOOL_LINK_OVERHEAD_BYTES = 128

type Link = {
  position: number
  uuid: string
  parentUuid: string | undefined
  logicalParentUuid: string | undefined
  type: 'user' | 'assistant' | 'attachment' | 'system' | undefined
  message?: { id: string | undefined; content: Record<string, unknown>[] }
}

function messageRowType(type: unknown): Link['type'] {
  return type === 'user' || type === 'assistant' || type === 'attachment' || type === 'system'
    ? type
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// A parsed string can share storage with the entire source line.
function copyLinkText(value: string): string {
  return Buffer.from(value, 'utf16le').toString('utf16le')
}

export function createClaudeImportIndex() {
  const links: Link[] = []
  const positions = new Set<number>()
  let bytes = 0
  const charge = (size: number) => {
    bytes += size
    if (bytes > MAX_INDEX_BYTES) {
      throw new Error('Claude transcript link index exceeds its memory budget')
    }
  }

  return {
    record(row: Record<string, unknown>, position: number) {
      if (row.isSidechain === true || row.parent_tool_use_id != null) {
        return
      }
      const type = messageRowType(row.type)
      if (typeof row.uuid !== 'string' || !row.uuid) {
        if (type) {
          charge(LINK_OVERHEAD_BYTES)
          positions.add(position)
        }
        return
      }
      const parentUuid = string(row.parentUuid)
      const logicalParentUuid = string(row.logicalParentUuid)
      const message = type ? claudeRecord(row.message) : null
      const id = type === 'assistant' ? string(message?.id) : undefined
      charge(
        LINK_OVERHEAD_BYTES +
          2 *
            (row.uuid.length +
              (parentUuid?.length ?? 0) +
              (logicalParentUuid?.length ?? 0) +
              (id?.length ?? 0))
      )
      const link: Link = {
        position,
        uuid: copyLinkText(row.uuid),
        parentUuid: parentUuid && copyLinkText(parentUuid),
        logicalParentUuid: logicalParentUuid && copyLinkText(logicalParentUuid),
        type
      }
      const content: Record<string, unknown>[] = []
      if (Array.isArray(message?.content)) {
        for (const value of message.content) {
          const part = claudeRecord(value)
          if (part?.type === 'tool_use' && typeof part.id === 'string') {
            charge(TOOL_LINK_OVERHEAD_BYTES + 2 * part.id.length)
            content.push({ type: 'tool_use', id: copyLinkText(part.id) })
          } else if (
            type === 'user' &&
            part?.type === 'tool_result' &&
            typeof part.tool_use_id === 'string'
          ) {
            charge(TOOL_LINK_OVERHEAD_BYTES + 2 * part.tool_use_id.length)
            content.push({ type: 'tool_result', tool_use_id: copyLinkText(part.tool_use_id) })
          }
        }
      }
      if (id || content.length) {
        link.message = { id: id && copyLinkText(id), content }
      }
      links.push(link)
    },
    async select(check: () => void, newestFirst: boolean) {
      const { rows } = await mainChainAsync(newestFirst ? links.toReversed() : links, check)
      const selected = rows.length ? rows : links
      for (let index = 0; index < selected.length; index++) {
        check()
        const row = selected[index]
        if (rows.length ? row.type : row.type === 'system') {
          positions.add(row.position)
        }
        if (index % 256 === 255) {
          await setImmediate()
        }
      }
      links.length = 0
      return positions
    }
  }
}
