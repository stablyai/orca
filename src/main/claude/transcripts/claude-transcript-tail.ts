import { open, type FileHandle } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { claudeRecord } from '../structured/journal/claude-structured-item-translation'
import { mainChainAsync } from './claude-transcript-chain'
import { isClaudeConversationEntry } from './claude-conversation-fork-boundary'
export { mainChain } from './claude-transcript-chain'

// Read backward to the saved leaf so catch-up costs only the appended stretch, not the whole conversation.

const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 16 * 1024 * 1024
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
  let hasNewConversation = false
  let covered = false
  const result = await visitClaudeTranscriptTail(input, (row) => {
    const boundary = typeof row.uuid === 'string' && input.chainBoundaries?.includes(row.uuid)
    covered ||= boundary === true
    if (row.uuid === input.leafUuid && !boundary) {
      return true
    }
    if (!covered && isClaudeConversationEntry(row)) {
      hasNewConversation = true
    }
    if (!boundary) {
      newestFirst.push(row)
    }
    return false
  })
  if (result.outcome === 'found' || covered) {
    if (covered && !hasNewConversation) {
      return { rows: [], rewound: false }
    }
    const tail = await mainChainAsync(
      newestFirst.toReversed(),
      input.check,
      input.leafUuid,
      covered ? input.chainBoundaries : []
    )
    if (result.outcome !== 'capacity' || !tail.rewound) {
      return tail
    }
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
  const range = {
    ...input,
    endBytes: input.consumedBytes,
    // Ordinary catch-up's bound: an unchanged reopen must not cost a recovery-sized read.
    maxBytes: input.maxBytes ?? CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES
  }
  await visitClaudeTranscriptTail(range, (row) => {
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
export const CLAUDE_TRANSCRIPT_WINDOW_RAW_MAX_BYTES = 64 * 1024 * 1024

type TranscriptSource = { filePath: string } | { handle: FileHandle }
type TranscriptRowVisitor = (row: Record<string, unknown>, recordEnd: number) => boolean

export async function readClaudeTranscriptWindow(
  input: TranscriptSource & {
    check: () => void
    endBytes?: number
    maxBytes?: number
    visit?: TranscriptRowVisitor
    select?: (recordEnd: number) => boolean
  }
): Promise<{
  rows: Record<string, unknown>[]
  bytesRead: number
  decodedBytes: number
  consumedBytes: number
  sourceBytes: number
  sourceMtimeMs: number
  /** Complete records over the per-record cap that were passed over, not decoded. */
  skippedRecords: number
}> {
  const newestFirst: Record<string, unknown>[] = []
  const cap = input.visit
    ? CLAUDE_TRANSCRIPT_WINDOW_RAW_MAX_BYTES
    : CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES
  const result = await visitClaudeTranscriptTail(
    {
      ...input,
      maxBytes: Math.min(input.maxBytes ?? cap, cap)
    },
    (row, recordEnd) => {
      if (input.visit) {
        return input.visit(row, recordEnd)
      }
      newestFirst.push(row)
      return false
    },
    input.select
  )
  return { ...result, rows: newestFirst.toReversed() }
}

async function visitClaudeTranscriptTail(
  input: TranscriptSource & { endBytes?: number; maxBytes?: number; check: () => void },
  visit: TranscriptRowVisitor,
  select?: (recordEnd: number) => boolean
): Promise<{
  outcome: 'found' | 'absent' | 'capacity'
  bytesRead: number
  decodedBytes: number
  consumedBytes: number
  sourceBytes: number
  sourceMtimeMs: number
  /** Complete records over the per-record cap that were passed over, not decoded. */
  skippedRecords: number
}> {
  const maxBytes = input.maxBytes ?? CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES
  const handle = 'handle' in input ? input.handle : await open(input.filePath, 'r')
  try {
    input.check()
    const { size, mtimeMs } = await handle.stat()
    const endBytes = Math.min(size, input.endBytes ?? size)
    input.check()
    let bytesRead = 0
    let decodedBytes = 0
    let consumedBytes = 0
    let skippedRecords = 0
    const result = (outcome: 'found' | 'absent' | 'capacity') => ({
      outcome,
      bytesRead,
      decodedBytes,
      consumedBytes,
      sourceBytes: endBytes,
      sourceMtimeMs: mtimeMs,
      skippedRecords
    })
    // Retain split-line chunks newest first while reading backward.
    let pieces: Buffer[] = []
    let recordBytes = 0
    let skipped = false
    let rowsSinceYield = 0
    let bytesSinceYield = 0
    // A last line without its newline is a write still landing; it is left for the next read.
    let complete = false
    let recordEnd = endBytes
    let selected = false
    const append = (piece: Buffer) => {
      recordBytes += piece.length
      if (recordBytes > MAX_RECORD_BYTES) {
        pieces = []
        skipped = true
      } else if (selected) {
        pieces.push(piece)
      }
    }
    const endLine = async (nextRecordEnd: number): Promise<boolean> => {
      const bytes = selected && !skipped ? Buffer.concat(pieces.toReversed()) : null
      skippedRecords += complete && skipped ? 1 : 0
      decodedBytes += bytes?.length ?? 0
      const row = bytes ? parseRow(bytes) : null
      const found = row !== null && visit(row, recordEnd)
      bytesSinceYield += recordBytes
      pieces = []
      recordBytes = 0
      skipped = false
      complete = true
      recordEnd = nextRecordEnd
      selected = select?.(recordEnd) ?? true
      if (++rowsSinceYield >= 256 || bytesSinceYield >= 1024 * 1024) {
        await setImmediate()
        input.check()
        rowsSinceYield = 0
        bytesSinceYield = 0
      }
      return found
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
        append(chunk.subarray(index + 1, end))
        end = index
        if (await endLine(position + index)) {
          return result('found')
        }
      }
      append(chunk.subarray(0, end))
    }
    return result((await endLine(0)) ? 'found' : 'absent')
  } finally {
    if ('filePath' in input) {
      await handle.close()
    }
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
