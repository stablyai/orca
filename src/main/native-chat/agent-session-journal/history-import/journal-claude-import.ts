import { createReadStream, type Stats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES,
  readClaudeTranscriptWindow
} from '../../../claude/transcripts/claude-transcript-tail'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import {
  decodeClaudeTranscriptRecord,
  mayBeClaudeConversationEntry
} from '../../transcript-decoding/transcript-line-decoders-claude'
import {
  splitTranscriptStreamLineBatches,
  type TranscriptLine
} from '../../transcript-streaming/transcript-stream-lines'
import { transcriptFallbackId } from '../../transcript-streaming/transcript-fallback-id'
import { claudeLegacyIdentity } from './journal-legacy-identity'
import { createNewestFirstItemWindow } from './journal-newest-item-window'
import { createClaudeImportGraph } from './journal-claude-import-graph'
import type { ClaudeImportScratchOptions } from './journal-claude-import-scratch'
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
  scratch?: ClaudeImportScratchOptions
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
  record: (row: Row | null, position: number, lineIndex?: number) => void
  select: () => Promise<void>
  item: (row: Row, index: number, fallbackId: string) => JournalReplacementItem | undefined
  check: () => void
}

export async function importClaudeTranscript(input: ImportInput): Promise<ImportResult> {
  const graph = createClaudeImportGraph(input.scratch)
  let conversation = false
  const check = () => input.signal?.throwIfAborted()
  const scan: ImportScan = {
    check,
    record(row, position, lineIndex = -1) {
      check()
      conversation ||= mayBeClaudeConversationEntry(row)
      if (row) {
        graph.record(row, position, lineIndex)
      }
    },
    select: () => graph.select(check),
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
          // OpenClaude keeps Claude's transcript format; item identities keep the requested agent.
          agent: 'claude',
          filePath: input.filePath,
          source: input.source,
          signal: input.signal,
          maxSourceBytes: 16 * 1024 * 1024
        })
      : null
  try {
    const result = input.bounded
      ? await importClaudeWindow(input, scan, graph)
      : await importClaudeFile(input, scan, graph, source?.observe)
    const sourceEmpty = result.sourceConsumedBytes === 0 || !conversation
    if (!sourceEmpty) {
      await source?.validate()
    }
    return { ...result, sourceEmpty, forkTipItemIds: [] }
  } finally {
    await graph.close()
  }
}

type ClaudeImportGraph = ReturnType<typeof createClaudeImportGraph>

async function importClaudeWindow(input: ImportInput, scan: ImportScan, graph: ClaudeImportGraph) {
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
      select: () => true,
      visit(row, position) {
        if (sourceFrontier === undefined && typeof row.uuid === 'string' && row.uuid) {
          sourceFrontier = row.uuid
        }
        scan.record(row, position)
        return false
      }
    })
    await scan.select()
    const retained = await retainNewest(input, scan, graph, () => '#-1')
    await checkTranscriptSnapshot(input.filePath, snapshot, scan.check)
    return {
      items: retained.items(),
      retainedBytes: retained.retainedBytes(),
      sourceConsumedBytes: first.consumedBytes,
      sourceFrontier,
      sourceMtimeMs: snapshot.mtimeMs,
      sourceSkippedRecords: first.skippedRecords
    }
  } finally {
    await handle.close()
  }
}

async function retainNewest(
  input: ImportInput,
  scan: ImportScan,
  graph: ClaudeImportGraph,
  fallbackId: (position: number) => string
) {
  const retained = createNewestFirstItemWindow(input.retainedBytes)
  let decoded = 0
  for (const payload of graph.payloads()) {
    scan.check()
    const row = claudeRecord(JSON.parse(payload.raw))
    const item = row && scan.item(row, payload.lineIndex, fallbackId(payload.position))
    if (item && !retained.offer(item)) {
      break
    }
    if (++decoded % 256 === 0) {
      await setImmediate()
    }
  }
  return retained
}

/** The forward import retains absolute line indices for UUID-less legacy messages. */
async function importClaudeFile(
  input: ImportInput,
  scan: ImportScan,
  graph: ClaudeImportGraph,
  observe: ((line: string) => void) | undefined
) {
  const snapshot = await stat(input.filePath)
  const frontierCutoff = snapshot.size - CLAUDE_TRANSCRIPT_TAIL_MAX_BYTES
  let sourceFrontier: string | undefined
  const sourceConsumedBytes = await visitClaudeFile(input, snapshot.size, scan.check, {
    observe,
    visit(row, index, offset, record) {
      scan.record(row, offset, index)
      // The backward frontier probe needs the delimiter before a row, unless it starts at BOF.
      const withinProbe = offset > frontierCutoff || (offset === 0 && frontierCutoff === 0)
      if (record.terminated && withinProbe && typeof row?.uuid === 'string' && row.uuid) {
        sourceFrontier = row.uuid
      }
    }
  })
  await scan.select()
  const retained = await retainNewest(input, scan, graph, (position) =>
    transcriptFallbackId(input.filePath, position)
  )
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
    start?: number
    lineIndex?: number
    select?: (offset: number) => boolean
    observe?: (line: string) => void
    visit: (row: Row | null, lineIndex: number, offset: number, record: TranscriptLine) => void
  }
): Promise<number> {
  check()
  if (!size) {
    return 0
  }
  let consumedBytes = options.start ?? 0
  let index = options.lineIndex ?? 0
  let rowsSinceYield = 0
  let bytesSinceYield = 0
  const stream = createReadStream(input.filePath, {
    start: options.start,
    end: size - 1,
    signal: input.signal
  })
  try {
    for await (const batch of splitTranscriptStreamLineBatches(stream, 16 * 1024 * 1024, true)) {
      for (const record of batch) {
        check()
        const offset = consumedBytes
        consumedBytes += record.byteLength
        bytesSinceYield += record.byteLength
        const line = record.line.endsWith('\r') ? record.line.slice(0, -1) : record.line
        if (line) {
          const lineIndex = index++
          if (options.select?.(offset) ?? true) {
            options.observe?.(line)
            let row: Row | null = null
            try {
              row = claudeRecord(JSON.parse(line))
            } catch {
              // Foreign and torn records still advance the legacy line index.
            }
            options.visit(row, lineIndex, offset, record)
          }
        }
        if (++rowsSinceYield >= 256 || bytesSinceYield >= 1024 * 1024) {
          await setImmediate()
          check()
          rowsSinceYield = 0
          bytesSinceYield = 0
        }
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
