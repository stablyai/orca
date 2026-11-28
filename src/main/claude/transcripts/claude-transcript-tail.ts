import { isClaudeConversationEntry } from './claude-conversation-fork-boundary'
import { open } from 'node:fs/promises'
import { claudeRecord } from '../structured/journal/claude-structured-item-translation'

// Read backward to the saved leaf so catch-up costs only the appended stretch, not the whole conversation.

const CHUNK_BYTES = 64 * 1024
/** One read's budget; an outside stretch larger than this is not caught up. */
export const CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES = 16 * 1024 * 1024

export type ClaudeTranscriptTail = {
  /** The main chain from the saved leaf (exclusive) to the newest row, oldest first. */
  rows: Record<string, unknown>[]
  // The chain leaves this stretch before the saved leaf, indicating an external rewind or edit.
  rewound: boolean
}

/** The rows written after `leafUuid`, or null when its row is not within the budget. */
export async function readClaudeTranscriptTail(input: {
  filePath: string
  leafUuid: string
  maxBytes?: number
  check: () => void
  onLeafAbsent?: () => void
  /** Instead of `leafUuid`: a message whose saved text may be partial (a streamed block's), so the
   *  tail starts at its own rows, read again. */
  throughMessage?: string
}): Promise<ClaudeTranscriptTail | null> {
  const maxBytes = input.maxBytes ?? CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES
  const handle = await open(input.filePath, 'r')
  try {
    input.check()
    const { size } = await handle.stat()
    input.check()
    const newestFirst: Record<string, unknown>[] = []
    // The newest row of `throughMessage` read so far going backward: its earliest, once past it.
    const seen: { through?: Record<string, unknown> } = {}
    /** The tail once `row` ends it; null to read on (`row` is then part of it). */
    const ends = (row: Record<string, unknown>): ClaudeTranscriptTail | null => {
      if (input.throughMessage === undefined) {
        return row.uuid === input.leafUuid
          ? mainChain(newestFirst.toReversed(), input.leafUuid)
          : null
      }
      if (claudeRecord(row.message)?.id === input.throughMessage) {
        seen.through = row
        return null
      }
      return seen.through ? mainChain(newestFirst.toReversed(), parentOf(seen.through)) : null
    }
    // Retain split-line chunks newest first while reading backward.
    let pieces: Buffer[] = []
    // A last line without its newline is a write still landing; it is left for the next read.
    let complete = false
    const endLine = (): Record<string, unknown> | null => {
      const row = complete ? parseRow(Buffer.concat(pieces.toReversed())) : null
      pieces = []
      complete = true
      return row
    }
    let position = size
    while (position > 0) {
      input.check()
      if (size - position >= maxBytes) {
        return null
      }
      const length = Math.min(CHUNK_BYTES, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, position)
      input.check()
      let end = length
      for (let index = length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 0x0a) {
          continue
        }
        pieces.push(chunk.subarray(index + 1, end))
        end = index
        const row = endLine()
        const tail = row && ends(row)
        if (tail) {
          return tail
        }
        if (row) {
          newestFirst.push(row)
        }
      }
      pieces.push(chunk.subarray(0, end))
    }
    const first = endLine()
    const tail = (first && ends(first)) ?? null
    if (tail) {
      return tail
    }
    if (first) {
      newestFirst.push(first)
    }
    if (seen.through) {
      return mainChain(newestFirst.toReversed(), parentOf(seen.through))
    }
    input.onLeafAbsent?.()
    return null
  } finally {
    await handle.close()
  }
}

function parentOf(row: Record<string, unknown>): string {
  const parent = typeof row.parentUuid === 'string' ? row.parentUuid : row.logicalParentUuid
  return typeof parent === 'string' ? parent : ''
}

function parseRow(bytes: Buffer): Record<string, unknown> | null {
  if (bytes.length === 0) {
    return null
  }
  try {
    return claudeRecord(JSON.parse(bytes.toString('utf8')))
  } catch {
    // A torn or foreign line is not part of the conversation.
    return null
  }
}

/** Walk parent links back from the newest row; rows on other branches and sidechains drop out. */
export function mainChain(rows: Record<string, unknown>[], leafUuid: string): ClaudeTranscriptTail {
  const byUuid = new Map<string, Record<string, unknown>>()
  let newest: Record<string, unknown> | null = null
  for (const row of rows) {
    if (
      typeof row.uuid === 'string' &&
      row.isSidechain !== true &&
      row.parent_tool_use_id == null
    ) {
      byUuid.set(row.uuid, row)
      if (isClaudeConversationEntry(row)) {
        newest = row
      }
    }
  }
  const chain: Record<string, unknown>[] = []
  let rewound = false
  for (let row = newest; row;) {
    chain.push(row)
    // Each row is visited once, so a parent loop in a damaged file ends the walk.
    byUuid.delete(String(row.uuid))
    // A compaction boundary starts a fresh chain and names the one it continues.
    const parent = typeof row.parentUuid === 'string' ? row.parentUuid : row.logicalParentUuid
    if (parent === leafUuid) {
      break
    }
    const next = typeof parent === 'string' ? byUuid.get(parent) : undefined
    if (!next) {
      rewound = true
      break
    }
    row = next
  }
  return { rows: chain.toReversed(), rewound }
}
