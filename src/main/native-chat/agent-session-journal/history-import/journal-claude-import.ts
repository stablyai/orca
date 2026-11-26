import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NATIVE_CHAT_NOTICE_COPY } from '../../../../shared/native-chat/transcript/notices/native-chat-notice'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { timestampMs } from '../../../ai-vault/parsing/session-record-time'
import {
  decodeClaudeTranscriptRecord,
  mayBeClaudeConversationEntry
} from '../../transcript-decoding/transcript-line-decoders-claude'
import { transcriptFallbackId } from '../../transcript-streaming/transcript-fallback-id'
import { claudeLegacyIdentity } from './journal-legacy-identity'
import { MAX_LEGACY_IMPORT_RECORD_BYTES } from './journal-legacy-transcript-stream'
import { ClaudeImportIndex } from './journal-claude-import-index'
import { readClaudeImportLinks } from './journal-claude-import-links'
import { ClaudeImportSource } from './journal-claude-import-source'
import {
  ClaudeImportResourceError,
  type ClaudeImportGrowth
} from './journal-claude-import-resource-error'
import { replacementItem } from './journal-replacement-items'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'

export type ClaudeImportInput = {
  agent: AgentType
  filePath: string
  sessionId: string
  signal?: AbortSignal
  source?: AdoptedTranscriptSource
  limits: JournalPayloadLimits
  retainedBytes: number
  decodedMessageIdentities?: true
  growth?: ClaudeImportGrowth
}

export async function importClaudeTranscript(input: ClaudeImportInput) {
  input.signal?.throwIfAborted()
  const file = await ClaudeImportSource.open(input.filePath, input.signal, input.growth)
  try {
    const prepared = await collectClaudeItems(file, input)
    return {
      ...prepared,
      verify: () => file.verify(),
      close: () => file.close()
    }
  } catch (error) {
    await file.close()
    throw error
  }
}

async function collectClaudeItems(file: ClaudeImportSource, input: ClaudeImportInput) {
  const { filePath, sessionId, agent, signal } = input
  const check = () => signal?.throwIfAborted()
  const observer = input.source
    ? adoptedTranscriptSourceObserver({
        agent,
        filePath,
        source: input.source,
        signal,
        maxSourceBytes: MAX_LEGACY_IMPORT_RECORD_BYTES
      })
    : null
  const index = new ClaudeImportIndex()
  let conversation = false
  const items: Buffer[] = []
  const encode = (message: NativeChatMessage, row: Record<string, unknown>, line: number) =>
    Buffer.from(
      JSON.stringify(
        replacementItem(
          message,
          input.decodedMessageIdentities
            ? { provider: 'legacy', agent, sessionId, recordId: message.id }
            : claudeLegacyIdentity(row, line, agent, sessionId),
          input.limits
        )
      )
    )
  try {
    await file.scan((bytes, range) => {
      const row = readClaudeImportLinks(bytes)
      conversation ||= mayBeClaudeConversationEntry(row)
      if (row) {
        observer?.observeRecord(row)
        index.record(row, range)
      }
    }, input.growth?.prefix)
    await file.indexedVersion()
    const compaction = await index.select(check)
    await file.indexedVersion()
    let retained = 0
    let summaryParent: string | undefined
    window: for await (const batch of file.reread(index.ranges())) {
      for (const range of batch.ranges) {
        check()
        const offset = range.offset - batch.start
        const row = parseJsonObject(batch.bytes.toString('utf8', offset, offset + range.length))
        if (row && range.line === compaction?.summary.line) {
          const content = asRecord(row.message)?.content
          if (
            typeof row.parentUuid === 'string' &&
            (typeof content === 'string'
              ? Boolean(content.trim())
              : Array.isArray(content) &&
                content.some((part) => {
                  const block = asRecord(part)
                  return (
                    block?.type === 'text' &&
                    typeof block.text === 'string' &&
                    Boolean(block.text.trim())
                  )
                }))
          ) {
            summaryParent = row.parentUuid
          }
        }
        const message =
          row &&
          decodeClaudeTranscriptRecord(row, transcriptFallbackId(filePath, range.legacyOffset))
        if (message) {
          const item = encode(message, row, range.line)
          retained += item.length
          if (retained > input.retainedBytes) {
            if (!items.length) {
              throw new ClaudeImportResourceError(
                'The newest Claude history item exceeds the import window.'
              )
            }
            break window
          }
          items.push(item)
        }
      }
    }
    // A validated summary can explain an empty projection without saving the summary itself.
    if (!items.length && compaction && summaryParent) {
      const { boundary } = compaction
      for await (const { bytes } of file.reread([boundary])) {
        const row = parseJsonObject(bytes.toString('utf8'))
        if (row?.uuid === summaryParent) {
          const timestamp = timestampMs(row.timestamp)
          const item = encode(
            {
              id: summaryParent,
              role: 'system',
              blocks: [
                {
                  type: 'text',
                  text: NATIVE_CHAT_NOTICE_COPY.compaction,
                  presentation: 'compaction'
                }
              ],
              timestamp: Number.isFinite(timestamp) ? timestamp : null,
              source: 'transcript'
            },
            row,
            boundary.line
          )
          if (item.length > input.retainedBytes) {
            throw new ClaudeImportResourceError(
              'The newest Claude history item exceeds the import window.'
            )
          }
          items.push(item)
        }
      }
    }
  } finally {
    index.dispose()
  }
  const sourceEmpty = !conversation && !items.length
  return {
    items: items.toReversed(),
    sourceEmpty,
    identity: sourceEmpty ? undefined : await observer?.identity()
  }
}
