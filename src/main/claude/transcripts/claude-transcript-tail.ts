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
  chainBoundaries?: readonly string[]
  maxBytes?: number
  check: () => void
  onLeafAbsent?: () => void
}): Promise<ClaudeTranscriptTail | null> {
  const newestFirst: Record<string, unknown>[] = []
  let covered = false
  const result = await visitClaudeTranscriptTail(input, (row) => {
    covered ||= input.chainBoundaries?.includes(String(row.uuid)) === true
    if (row.uuid === input.leafUuid) {
      return true
    }
    if (!covered) {
      newestFirst.push(row)
    }
    return false
  })
  if (result.outcome === 'found') {
    return mainChain(newestFirst.toReversed(), input.leafUuid, covered ? input.chainBoundaries : [])
  }
  if (result.outcome === 'absent') {
    input.onLeafAbsent?.()
  }
  return null
}

/** Only complete records in the consumed range can anchor the next catch-up. */
export async function readClaudeTranscriptFrontier(input: {
  filePath: string
  consumedBytes: number
  maxBytes?: number
  check: () => void
}): Promise<string | undefined> {
  let frontier: string | undefined
  await visitClaudeTranscriptTail({ ...input, endBytes: input.consumedBytes }, (row) => {
    if (typeof row.uuid !== 'string' || !row.uuid) {
      return false
    }
    frontier = row.uuid
    return true
  })
  return frontier
}

/** Recovery bounds source work as well as the retained item window. */
export const CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES = 20 * 1024 * 1024

export async function readClaudeTranscriptWindow(input: {
  filePath: string
  check: () => void
}): Promise<{
  rows: Record<string, unknown>[]
  bytesRead: number
  decodedBytes: number
  consumedBytes: number
  sourceBytes: number
}> {
  const newestFirst: Record<string, unknown>[] = []
  const result = await visitClaudeTranscriptTail(
    { ...input, maxBytes: CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES },
    (row) => {
      newestFirst.push(row)
      return false
    }
  )
  return { ...result, rows: newestFirst.toReversed() }
}

async function visitClaudeTranscriptTail(
  input: { filePath: string; endBytes?: number; maxBytes?: number; check: () => void },
  visit: (row: Record<string, unknown>) => boolean
): Promise<{
  outcome: 'found' | 'absent' | 'capacity'
  bytesRead: number
  decodedBytes: number
  consumedBytes: number
  sourceBytes: number
}> {
  const maxBytes = input.maxBytes ?? CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES
  const handle = await open(input.filePath, 'r')
  try {
    input.check()
    const { size } = await handle.stat()
    const endBytes = Math.min(size, input.endBytes ?? size)
    input.check()
    let bytesRead = 0
    let decodedBytes = 0
    let consumedBytes = 0
    const result = (outcome: 'found' | 'absent' | 'capacity') => ({
      outcome,
      bytesRead,
      decodedBytes,
      consumedBytes,
      sourceBytes: endBytes
    })
    // Retain split-line chunks newest first while reading backward.
    let pieces: Buffer[] = []
    // A last line without its newline is a write still landing; it is left for the next read.
    let complete = false
    const endLine = (): boolean => {
      const bytes = complete ? Buffer.concat(pieces.toReversed()) : null
      decodedBytes += bytes?.length ?? 0
      const row = bytes ? parseRow(bytes) : null
      pieces = []
      complete = true
      return row !== null && visit(row)
    }
    let position = endBytes
    while (position > 0) {
      input.check()
      const remaining = maxBytes - (endBytes - position)
      if (remaining <= 0) {
        return result('capacity')
      }
      const length = Math.min(CHUNK_BYTES, position, remaining)
      position -= length
      const chunk = Buffer.alloc(length)
      const read = await handle.read(chunk, 0, length, position)
      bytesRead += read.bytesRead
      if (read.bytesRead !== length) {
        throw new Error('Claude transcript changed while reading its window')
      }
      input.check()
      let end = length
      for (let index = length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 0x0a) {
          continue
        }
        if (!complete) {
          consumedBytes = position + index + 1
        }
        pieces.push(chunk.subarray(index + 1, end))
        end = index
        if (endLine()) {
          return result('found')
        }
      }
      pieces.push(chunk.subarray(0, end))
    }
    return result(endLine() ? 'found' : 'absent')
  } finally {
    await handle.close()
  }
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
export function mainChain(
  rows: Record<string, unknown>[],
  leafUuid: string,
  chainBoundaries: readonly string[] = []
): ClaudeTranscriptTail {
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
    if (parent === leafUuid || (typeof parent === 'string' && chainBoundaries.includes(parent))) {
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
