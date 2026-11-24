import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import {
  decodeClaudeTranscriptRecord,
  mayBeClaudeConversationEntry
} from '../../transcript-decoding/transcript-line-decoders-claude'
import { splitTranscriptStreamLineBatches } from '../../transcript-streaming/transcript-stream-lines'
import { transcriptFallbackId } from '../../transcript-streaming/transcript-fallback-id'
import { claudeLegacyIdentity } from './journal-legacy-identity'
import { MAX_LEGACY_IMPORT_RECORD_BYTES } from './journal-legacy-transcript-stream'
import { createNewestFirstItemWindow } from './journal-newest-item-window'
import { createClaudeImportGraph } from './journal-claude-import-graph'
import type { ClaudeImportScratchOptions } from './journal-claude-import-scratch'
import { replacementItem } from './journal-replacement-items'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'

type ImportInput = {
  agent: AgentType
  filePath: string
  sessionId: string
  signal?: AbortSignal
  source?: AdoptedTranscriptSource
  limits: JournalPayloadLimits
  retainedBytes: number
  decodedMessageIdentities?: true
  scratch?: ClaudeImportScratchOptions
}

export async function importClaudeTranscript(input: ImportInput) {
  const { filePath, sessionId, agent, signal } = input
  const check = () => signal?.throwIfAborted()
  check()
  const snapshot = await stat(filePath)
  check()
  if (snapshot.size === 0) {
    return { items: [], sourceEmpty: true }
  }
  const source = input.source
    ? adoptedTranscriptSourceObserver({
        agent: 'claude',
        filePath,
        source: input.source,
        signal,
        maxSourceBytes: MAX_LEGACY_IMPORT_RECORD_BYTES
      })
    : null
  const graph = createClaudeImportGraph(input.scratch)
  const retained = createNewestFirstItemWindow(input.retainedBytes)
  let conversation = false
  let position = 0
  let lineIndex = 0
  let rowsSinceYield = 0
  let bytesSinceYield = 0
  try {
    const stream = createReadStream(filePath, { end: snapshot.size - 1, signal })
    for await (const batch of splitTranscriptStreamLineBatches(
      stream,
      MAX_LEGACY_IMPORT_RECORD_BYTES
    )) {
      for (const record of batch) {
        check()
        const offset = position
        position += record.byteLength
        bytesSinceYield += record.byteLength
        const line = record.line.endsWith('\r') ? record.line.slice(0, -1) : record.line
        if (line) {
          source?.observe(line)
          const row = parseJsonObject(line)
          conversation ||= mayBeClaudeConversationEntry(row)
          if (row) {
            graph.record(row, line, offset, lineIndex)
          }
          lineIndex += 1
        }
        if (++rowsSinceYield >= 256 || bytesSinceYield >= 1024 * 1024) {
          await setImmediate()
          rowsSinceYield = 0
          bytesSinceYield = 0
        }
      }
    }
    await graph.select(check)
    let decoded = 0
    for (const payload of graph.payloads()) {
      check()
      const row = parseJsonObject(payload.raw)
      const message =
        row && decodeClaudeTranscriptRecord(row, transcriptFallbackId(filePath, payload.position))
      if (message) {
        conversation = true
        const identity = input.decodedMessageIdentities
          ? { provider: 'legacy' as const, agent, sessionId, recordId: message.id }
          : claudeLegacyIdentity(row, payload.lineIndex, agent, sessionId)
        if (!retained.offer(replacementItem(message, identity, input.limits))) {
          break
        }
      }
      if (++decoded % 256 === 0) {
        await setImmediate()
      }
    }
    const after = await stat(filePath)
    check()
    if (
      after.dev !== snapshot.dev ||
      after.ino !== snapshot.ino ||
      after.size < snapshot.size ||
      (after.size === snapshot.size && after.mtimeMs !== snapshot.mtimeMs)
    ) {
      throw new Error('Claude transcript changed while reading its window')
    }
    if (conversation) {
      await source?.validate()
    }
    return { items: retained.items(), sourceEmpty: !conversation }
  } finally {
    graph.close()
  }
}
