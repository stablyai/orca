import { createReadStream } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import {
  readClaudeTranscriptFrontier,
  readClaudeTranscriptWindow
} from '../../../claude/transcripts/claude-transcript-tail'
import { mainChainAsync } from '../../../claude/transcripts/claude-transcript-chain'
import { claudeRecord } from '../../../claude/structured/journal/claude-structured-item-translation'
import {
  decodeClaudeTranscriptRecord,
  mayBeClaudeConversationEntry
} from '../../transcript-decoding/transcript-line-decoders-claude'
import { splitTranscriptStreamLines } from '../../transcript-streaming/transcript-stream-lines'
import { transcriptFallbackId } from '../../transcript-streaming/transcript-fallback-id'
import { claudeLegacyIdentity } from './journal-legacy-identity'
import { createNewestItemWindow } from './journal-newest-item-window'
import { createClaudeImportWindow } from './journal-claude-import-window'
import { replacementItem } from './journal-replacement-items'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

/** First imports retain absolute line indices for older UUID-less message identities. */
export async function importClaudeTranscript(input: {
  filePath: string
  sessionId: string
  signal?: AbortSignal
  source?: AdoptedTranscriptSource
  limits: JournalPayloadLimits
  retainedBytes: number
  bounded?: true
  maxBytes?: number
  decodedMessageIdentities?: true
}): Promise<{
  items: JournalReplacementItem[]
  retainedBytes: number
  sourceEmpty: boolean
  forkTipItemIds: string[]
  sourceFrontier?: string
  sourceConsumedBytes: number
  sourceMtimeMs?: number
  sourceSkippedRecords: number
}> {
  const window = createClaudeImportWindow(input.retainedBytes, input.bounded === true)
  let conversation = false
  const check = () => input.signal?.throwIfAborted()
  const keep = (row: Record<string, unknown>, index: number, fallbackId: string) => {
    check()
    conversation ||= mayBeClaudeConversationEntry(row)
    if (row.isSidechain === true || row.parent_tool_use_id != null) {
      return
    }
    const message = decodeClaudeTranscriptRecord(row, fallbackId)
    if (!message) {
      window.keep(row)
      return
    }
    conversation = true
    if (input.bounded && (typeof row.uuid !== 'string' || !row.uuid)) {
      throw new Error('Claude recovery needs an absolute line index for a UUID-less message')
    }
    window.keep(
      row,
      replacementItem(
        message,
        input.decodedMessageIdentities
          ? {
              provider: 'legacy',
              agent: 'claude',
              sessionId: input.sessionId,
              recordId: message.id
            }
          : claudeLegacyIdentity(row, index, 'claude', input.sessionId),
        input.limits
      )
    )
  }
  let sourceConsumedBytes: number
  let sourceFrontier: string | undefined
  let sourceMtimeMs: number | undefined
  let sourceSkippedRecords = 0
  const source =
    !input.bounded && input.source
      ? adoptedTranscriptSourceObserver({
          agent: 'claude',
          filePath: input.filePath,
          source: input.source,
          signal: input.signal,
          maxSourceBytes: 16 * 1024 * 1024
        })
      : null
  if (input.bounded) {
    const read = await readClaudeTranscriptWindow({
      filePath: input.filePath,
      check,
      maxBytes: input.maxBytes,
      visit: (row) => {
        if (sourceFrontier === undefined && typeof row.uuid === 'string' && row.uuid) {
          sourceFrontier = row.uuid
        }
        keep(row, -1, '#-1')
        return window.complete()
      }
    })
    sourceConsumedBytes = read.consumedBytes
    sourceMtimeMs = read.sourceMtimeMs
    sourceSkippedRecords = read.skippedRecords
  } else {
    let index = 0
    let rowsSinceYield = 0
    let bytesSinceYield = 0
    sourceConsumedBytes = 0
    const stream = createReadStream(input.filePath, { signal: input.signal })
    try {
      for await (const record of splitTranscriptStreamLines(stream, 16 * 1024 * 1024)) {
        check()
        const fallbackId = transcriptFallbackId(input.filePath, sourceConsumedBytes)
        sourceConsumedBytes += record.byteLength
        bytesSinceYield += record.byteLength
        const line = record.line.endsWith('\r') ? record.line.slice(0, -1) : record.line
        if (line) {
          source?.observe(line)
          const lineIndex = index++
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            conversation = true
          }
          conversation ||= mayBeClaudeConversationEntry(parsed)
          const row = claudeRecord(parsed)
          if (row) {
            keep(row, lineIndex, fallbackId)
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
    sourceFrontier = await readClaudeTranscriptFrontier({
      filePath: input.filePath,
      consumedBytes: sourceConsumedBytes,
      check
    })
  }
  const selected = window.entries()
  const rows: Record<string, unknown>[] = []
  for (const { row } of selected) {
    check()
    rows.push(row)
    if (rows.length % 256 === 0) {
      await setImmediate()
    }
  }
  const chain = new Set((await mainChainAsync(rows, check)).rows)
  const retained = createNewestItemWindow(input.retainedBytes)
  let count = 0
  let bytesSinceYield = 0
  for (const { row, item, bytes } of selected) {
    check()
    bytesSinceYield += bytes
    if (++count % 256 === 0 || bytesSinceYield >= 1024 * 1024) {
      await setImmediate()
      check()
      bytesSinceYield = 0
    }
    if (!item) {
      continue
    }
    const uuidless = typeof row.uuid !== 'string' || !row.uuid
    // Legacy unlinked messages and local-command-only files keep their original identities.
    if (!uuidless && !chain.has(row) && !(chain.size === 0 && row.type === 'system')) {
      continue
    }
    retained.push(item)
  }
  if (conversation && sourceConsumedBytes > 0) {
    await source?.validate()
  }
  return {
    items: retained.items(),
    retainedBytes: retained.retainedBytes(),
    sourceEmpty: sourceConsumedBytes === 0 || !conversation,
    forkTipItemIds: [],
    sourceConsumedBytes,
    sourceFrontier,
    sourceMtimeMs,
    sourceSkippedRecords
  }
}
