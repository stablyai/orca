import { createReadStream, type Stats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES,
  readClaudeTranscriptFrontier,
  readClaudeTranscriptWindow
} from '../../../claude/transcripts/claude-transcript-tail'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import {
  decodeClaudeTranscriptRecord,
  mayBeClaudeConversationEntry
} from '../../transcript-decoding/transcript-line-decoders-claude'
import { splitTranscriptStreamLines } from '../../transcript-streaming/transcript-stream-lines'
import { transcriptFallbackId } from '../../transcript-streaming/transcript-fallback-id'
import { claudeLegacyIdentity } from './journal-legacy-identity'
import { createNewestItemWindow } from './journal-newest-item-window'
import { createClaudeImportIndex } from './journal-claude-import-index'
import { replacementItem } from './journal-replacement-items'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

type ImportInput = {
  agent: AgentType
  filePath: string
  sessionId: string
  signal?: AbortSignal
  source?: AdoptedTranscriptSource
  limits: JournalPayloadLimits
  retainedBytes: number
  bounded?: true
  maxBytes?: number
  decodedMessageIdentities?: true
}

type ImportResult = {
  items: JournalReplacementItem[]
  retainedBytes: number
  sourceEmpty: boolean
  forkTipItemIds: string[]
  sourceFrontier?: string
  sourceConsumedBytes: number
  sourceMtimeMs?: number
  sourceSkippedRecords: number
}

type Row = Record<string, unknown>
type ImportScan = {
  record: (parsed: unknown, position: number) => void
  select: (newestFirst: boolean) => Promise<Set<number>>
  item: (row: Row, index: number, fallbackId: string) => JournalReplacementItem | undefined
  check: () => void
}

export async function importClaudeTranscript(input: ImportInput): Promise<ImportResult> {
  const index = createClaudeImportIndex()
  let conversation = false
  const check = () => input.signal?.throwIfAborted()
  const scan: ImportScan = {
    check,
    record(parsed, position) {
      check()
      conversation ||= mayBeClaudeConversationEntry(parsed)
      const row = claudeRecord(parsed)
      if (row) {
        index.record(row, position)
      }
    },
    select: (newestFirst) => index.select(check, newestFirst),
    item(row, lineIndex, fallbackId) {
      check()
      const message = decodeClaudeTranscriptRecord(row, fallbackId)
      if (!message) {
        return undefined
      }
      conversation = true
      if (input.bounded && (typeof row.uuid !== 'string' || !row.uuid)) {
        throw new Error('Claude recovery needs an absolute line index for a UUID-less message')
      }
      return replacementItem(
        message,
        input.decodedMessageIdentities
          ? {
              provider: 'legacy',
              agent: input.agent,
              sessionId: input.sessionId,
              recordId: message.id
            }
          : claudeLegacyIdentity(row, lineIndex, input.agent, input.sessionId),
        input.limits
      )
    }
  }
  const source =
    !input.bounded && input.source
      ? adoptedTranscriptSourceObserver({
          agent: input.agent,
          filePath: input.filePath,
          source: input.source,
          signal: input.signal,
          maxSourceBytes: 16 * 1024 * 1024
        })
      : null
  const result = input.bounded
    ? await importClaudeWindow(input, scan)
    : await importClaudeFile(input, scan, source?.observe)
  const sourceEmpty = result.sourceConsumedBytes === 0 || !conversation
  if (!sourceEmpty) {
    await source?.validate()
  }
  return { ...result, sourceEmpty, forkTipItemIds: [] }
}

async function importClaudeWindow(input: ImportInput, scan: ImportScan) {
  const handle = await open(input.filePath, 'r')
  try {
    scan.check()
    const snapshot = await handle.stat()
    const range = {
      handle,
      check: scan.check,
      endBytes: snapshot.size,
      maxBytes: input.maxBytes
    }
    let sourceFrontier: string | undefined
    const first = await readClaudeTranscriptWindow({
      ...range,
      visit(row, position) {
        if (sourceFrontier === undefined && typeof row.uuid === 'string' && row.uuid) {
          sourceFrontier = row.uuid
        }
        scan.record(row, position)
        return false
      }
    })
    const selected = await scan.select(true)
    const items: JournalReplacementItem[] = []
    let itemBytes = 0
    if (selected.size) {
      let full = false
      await readClaudeTranscriptWindow({
        ...range,
        select: (position) => selected.has(position),
        visit(row, position) {
          selected.delete(position)
          const item = scan.item(row, -1, '#-1')
          if (item) {
            const bytes = Buffer.byteLength(JSON.stringify(item))
            if (items.length && itemBytes + bytes > input.retainedBytes) {
              full = true
              return true
            }
            items.push(item)
            itemBytes += bytes
          }
          return selected.size === 0
        }
      })
      if (!full && selected.size > 0) {
        throw new Error('Claude transcript changed while reading its window')
      }
    }
    await checkTranscriptSnapshot(input.filePath, snapshot, scan.check)
    return {
      items: items.toReversed(),
      retainedBytes: itemBytes + items.length + 2,
      sourceConsumedBytes: first.consumedBytes,
      sourceFrontier,
      sourceMtimeMs: snapshot.mtimeMs,
      sourceSkippedRecords: first.skippedRecords
    }
  } finally {
    await handle.close()
  }
}

/** The forward import retains absolute line indices for UUID-less legacy messages. */
async function importClaudeFile(
  input: ImportInput,
  scan: ImportScan,
  observe: ((line: string) => void) | undefined
) {
  const snapshot = await stat(input.filePath)
  const sourceConsumedBytes = await visitClaudeFile(input, snapshot.size, scan.check, {
    observe,
    visit: scan.record
  })
  const selected = await scan.select(false)
  const retained = createNewestItemWindow(input.retainedBytes)
  if (selected.size) {
    await visitClaudeFile(input, snapshot.size, scan.check, {
      select: (index) => selected.has(index),
      visit(parsed, index, offset) {
        selected.delete(index)
        const row = claudeRecord(parsed)
        if (row) {
          const item = scan.item(row, index, transcriptFallbackId(input.filePath, offset))
          if (item) {
            retained.push(item)
          }
        }
      }
    })
  }
  const sourceFrontier = await readClaudeTranscriptFrontier({
    filePath: input.filePath,
    consumedBytes: sourceConsumedBytes,
    maxBytes: CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES,
    check: scan.check
  })
  await checkTranscriptSnapshot(input.filePath, snapshot, scan.check)
  return {
    items: retained.items(),
    retainedBytes: retained.retainedBytes(),
    sourceConsumedBytes,
    sourceFrontier,
    sourceSkippedRecords: 0
  }
}

async function visitClaudeFile(
  input: Pick<ImportInput, 'filePath' | 'signal'>,
  size: number,
  check: () => void,
  options: {
    select?: (index: number) => boolean
    observe?: (line: string) => void
    visit: (parsed: unknown, index: number, offset: number) => void
  }
): Promise<number> {
  check()
  if (!size) {
    return 0
  }
  let consumedBytes = 0
  let index = 0
  let rowsSinceYield = 0
  let bytesSinceYield = 0
  const stream = createReadStream(input.filePath, { end: size - 1, signal: input.signal })
  try {
    for await (const record of splitTranscriptStreamLines(stream, 16 * 1024 * 1024)) {
      check()
      const offset = consumedBytes
      consumedBytes += record.byteLength
      bytesSinceYield += record.byteLength
      const line = record.line.endsWith('\r') ? record.line.slice(0, -1) : record.line
      if (line) {
        const lineIndex = index++
        if (options.select?.(lineIndex) ?? true) {
          options.observe?.(line)
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            // Foreign and torn records still advance the legacy line index.
          }
          options.visit(parsed, lineIndex, offset)
        }
      }
      if (++rowsSinceYield >= 256 || bytesSinceYield >= 1024 * 1024) {
        await setImmediate()
        check()
        rowsSinceYield = 0
        bytesSinceYield = 0
      }
    }
  } finally {
    stream.destroy()
  }
  return consumedBytes
}

async function checkTranscriptSnapshot(filePath: string, before: Stats, check: () => void) {
  const after = await stat(filePath)
  check()
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size < before.size ||
    (after.size === before.size && after.mtimeMs !== before.mtimeMs)
  ) {
    throw new Error('Claude transcript changed while reading its window')
  }
}
