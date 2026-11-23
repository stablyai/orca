import { setImmediate } from 'node:timers/promises'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import { mainChainAsync } from '../../../claude/transcripts/claude-transcript-chain'

// Leave heap headroom for the chain walker's maps, selected offsets, and decoded items.
const MAX_INDEX_BYTES = 6 * 1024 * 1024
const LINK_OVERHEAD_BYTES = 256
const TOOL_LINK_OVERHEAD_BYTES = 128

type Location = { position: number; lineIndex: number }
export type ClaudeImportSelection = {
  positions: Map<number, number>
  first: Location | undefined
  end: number
}

type Link = Location & {
  end: number
  bytes: number
  uuid?: string
  parentUuid?: string
  logicalParentUuid?: string
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

export function createClaudeImportIndex(newestFirst: boolean, maxBytes = MAX_INDEX_BYTES) {
  const capacity = Math.floor(maxBytes / LINK_OVERHEAD_BYTES)
  const links: (Link | undefined)[] = []
  const textBuffer = Buffer.allocUnsafe(256)
  let head = 0
  let count = 0
  let bytes = 0
  let saturated = false
  let spare: Link | undefined

  // Compact IDs must not keep the parsed source line alive.
  const copyLinkText = (value: string | undefined, reusable?: string): string | undefined => {
    if (value === reusable) {
      return reusable
    }
    if (value === undefined) {
      return undefined
    }
    const length = value.length * 2
    if (length > textBuffer.length) {
      return Buffer.from(value, 'utf16le').toString('utf16le')
    }
    textBuffer.write(value, 0, length, 'utf16le')
    return textBuffer.toString('utf16le', 0, length)
  }

  const push = (
    position: number,
    lineIndex: number,
    end: number,
    size: number,
    type: Link['type']
  ) => {
    const link = spare ?? { position, lineIndex, end, bytes: size, type }
    spare = undefined
    link.position = position
    link.lineIndex = lineIndex
    link.end = end
    link.bytes = size
    link.type = type
    link.uuid = undefined
    link.parentUuid = undefined
    link.logicalParentUuid = undefined
    link.message = undefined
    links[(head + count) % capacity] = link
    count++
    bytes += size
    return link
  }

  const makeRoom = (size: number) => {
    if (newestFirst) {
      saturated = bytes + size > maxBytes
      return !saturated
    }
    while (bytes + size > maxBytes && count > 0) {
      spare = links[head]!
      bytes -= spare.bytes
      links[head] = undefined
      head = (head + 1) % capacity
      count--
    }
    return size <= maxBytes
  }

  return {
    get full() {
      return saturated
    },
    record(row: Record<string, unknown>, position: number, lineIndex: number, end: number) {
      if (saturated || row.isSidechain === true || row.parent_tool_use_id != null) {
        return
      }
      const type = messageRowType(row.type)
      const uuid = string(row.uuid) || undefined
      if (!uuid) {
        if (type && makeRoom(LINK_OVERHEAD_BYTES)) {
          push(position, lineIndex, end, LINK_OVERHEAD_BYTES, type)
        }
        return
      }

      const parentUuid = string(row.parentUuid)
      const logicalParentUuid = string(row.logicalParentUuid)
      const message = type ? claudeRecord(row.message) : null
      const id = type === 'assistant' ? string(message?.id) : undefined
      let size =
        LINK_OVERHEAD_BYTES +
        2 *
          (uuid.length +
            (parentUuid?.length ?? 0) +
            (logicalParentUuid === parentUuid ? 0 : (logicalParentUuid?.length ?? 0)) +
            (id?.length ?? 0))
      if (!makeRoom(size)) {
        return
      }
      let content: Record<string, unknown>[] | undefined
      if (Array.isArray(message?.content)) {
        for (const value of message.content) {
          const part = claudeRecord(value)
          if (part?.type === 'tool_use' && typeof part.id === 'string') {
            size += TOOL_LINK_OVERHEAD_BYTES + 2 * part.id.length
            if (!makeRoom(size)) {
              return
            }
            content ??= []
            content.push({ type: 'tool_use', id: copyLinkText(part.id) })
          } else if (
            type === 'user' &&
            part?.type === 'tool_result' &&
            typeof part.tool_use_id === 'string'
          ) {
            size += TOOL_LINK_OVERHEAD_BYTES + 2 * part.tool_use_id.length
            if (!makeRoom(size)) {
              return
            }
            content ??= []
            content.push({ type: 'tool_result', tool_use_id: copyLinkText(part.tool_use_id) })
          }
        }
      }
      const previous = count > 0 ? links[(head + count - 1) % capacity] : undefined
      const link = push(position, lineIndex, end, size, type)
      link.uuid = copyLinkText(
        uuid,
        uuid === previous?.parentUuid ? previous.parentUuid : previous?.uuid
      )
      link.parentUuid = copyLinkText(
        parentUuid,
        parentUuid === previous?.uuid ? previous?.uuid : previous?.parentUuid
      )
      link.logicalParentUuid = copyLinkText(logicalParentUuid, link.parentUuid)
      if (id || content) {
        link.message = { id: copyLinkText(id, previous?.message?.id), content: content ?? [] }
      }
    },
    async select(check: () => void, maxRangeBytes?: number): Promise<ClaudeImportSelection> {
      const chronological: Link[] = []
      for (let index = 0; index < count; index++) {
        check()
        const offset = newestFirst ? count - 1 - index : index
        chronological.push(links[(head + offset) % capacity]!)
        if (index % 256 === 255) {
          await setImmediate()
        }
      }
      links.length = 0
      spare = undefined
      const { rows } = await mainChainAsync(chronological, check)
      const positions = new Map<number, number>()
      let end = 0
      const add = (row: Link) => {
        positions.set(row.position, row.lineIndex)
        end = Math.max(end, row.end)
      }
      for (let index = 0; index < chronological.length; index++) {
        check()
        const row = chronological[index]
        if (!row.uuid || (!rows.length && row.type === 'system')) {
          add(row)
        }
        if (index % 256 === 255) {
          await setImmediate()
        }
      }
      for (let index = 0; index < rows.length; index++) {
        check()
        const row = rows[index]
        if (row.type) {
          add(row)
        }
        if (index % 256 === 255) {
          await setImmediate()
        }
      }
      chronological.length = 0
      rows.length = 0
      let first: Location | undefined
      if (maxRangeBytes !== undefined) {
        // Trailing metadata does not spend the payload reread budget.
        const cutoff = end - maxRangeBytes
        let visited = 0
        for (const [position, lineIndex] of positions) {
          check()
          if (position < cutoff) {
            positions.delete(position)
          } else if (!first || position < first.position) {
            first = { position, lineIndex }
          }
          if (++visited % 256 === 0) {
            await setImmediate()
          }
        }
      }
      return { positions, first, end }
    }
  }
}
