import { createReadStream } from 'node:fs'
import {
  CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES,
  mainChain,
  readClaudeTranscriptFrontier,
  readClaudeTranscriptWindow
} from '../../../claude/transcripts/claude-transcript-tail'
import {
  decodeClaudeTranscriptRecord,
  mayBeClaudeConversationEntry
} from '../../transcript-decoding/transcript-line-decoders-claude'
import { decodeTranscriptStream } from '../../transcript-streaming/transcript-stream-lines'
import { claudeLegacyIdentity } from './journal-legacy-identity'
import { createNewestItemWindow } from './journal-newest-item-window'
import { replacementItem } from './journal-replacement-items'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

type Entry = {
  row: Record<string, unknown>
  index: number
  bytes: number
  fallbackId: string
}

/** First imports retain absolute line indices for older UUID-less message identities. */
export async function importClaudeTranscript(input: {
  filePath: string
  sessionId: string
  signal?: AbortSignal
  source?: AdoptedTranscriptSource
  limits: JournalPayloadLimits
  retainedBytes: number
  bounded?: true
  decodedMessageIdentities?: true
}): Promise<{
  items: JournalReplacementItem[]
  retainedBytes: number
  sourceEmpty: boolean
  forkTipItemIds: string[]
  sourceFrontier?: string
  sourceConsumedBytes: number
}> {
  const entries: (Entry | undefined)[] = []
  let start = 0
  let bytes = 0
  let conversation = false
  const keep = (
    row: Record<string, unknown>,
    index: number,
    fallbackId: string,
    rowBytes: number
  ) => {
    conversation ||= mayBeClaudeConversationEntry(row)
    const entry = { row, index, fallbackId, bytes: rowBytes }
    entries.push(entry)
    bytes += entry.bytes
    while (bytes > CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES && start < entries.length) {
      bytes -= entries[start]!.bytes
      entries[start++] = undefined
    }
    if (start > 1024 && start * 2 > entries.length) {
      entries.splice(0, start)
      start = 0
    }
  }
  let sourceConsumedBytes: number
  let sourceFrontier: string | undefined
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
    const window = await readClaudeTranscriptWindow({
      filePath: input.filePath,
      check: () => input.signal?.throwIfAborted()
    })
    sourceConsumedBytes = window.consumedBytes
    for (const row of window.rows) {
      input.signal?.throwIfAborted()
      keep(row, -1, '#-1', 0)
      if (typeof row.uuid === 'string' && row.uuid) {
        sourceFrontier = row.uuid
      }
    }
  } else {
    let index = 0
    const read = await decodeTranscriptStream(
      createReadStream(input.filePath, { signal: input.signal }),
      input.filePath,
      0,
      (line, fallbackId) => {
        source?.observe(line)
        const lineIndex = index++
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          conversation = true
          return null
        }
        conversation ||= mayBeClaudeConversationEntry(parsed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          keep(parsed as Record<string, unknown>, lineIndex, fallbackId, Buffer.byteLength(line))
        }
        return null
      },
      true,
      16 * 1024 * 1024
    )
    sourceConsumedBytes = read.consumedBytes
    sourceFrontier = await readClaudeTranscriptFrontier({
      filePath: input.filePath,
      consumedBytes: sourceConsumedBytes,
      check: () => input.signal?.throwIfAborted()
    })
  }
  const selected = entries.slice(start).filter((entry): entry is Entry => entry !== undefined)
  const chain = new Set(
    mainChain(
      selected.map(({ row }) => row),
      ''
    ).rows
  )
  const retained = createNewestItemWindow(input.retainedBytes)
  for (const { row, index, fallbackId } of selected) {
    input.signal?.throwIfAborted()
    if (row.isSidechain === true || row.parent_tool_use_id != null) {
      continue
    }
    const message = decodeClaudeTranscriptRecord(row, fallbackId)
    if (!message) {
      continue
    }
    conversation = true
    const uuidless = typeof row.uuid !== 'string' || !row.uuid
    if (uuidless && input.bounded) {
      throw new Error('Claude recovery needs an absolute line index for a UUID-less message')
    }
    // Legacy unlinked messages and local-command-only files keep their original identities.
    if (!uuidless && !chain.has(row) && !(chain.size === 0 && row.type === 'system')) {
      continue
    }
    retained.push(
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
  if (conversation && sourceConsumedBytes > 0) {
    await source?.validate()
  }
  return {
    items: retained.items(),
    retainedBytes: retained.retainedBytes(),
    sourceEmpty: sourceConsumedBytes === 0 || !conversation,
    forkTipItemIds: [],
    sourceConsumedBytes,
    sourceFrontier
  }
}
