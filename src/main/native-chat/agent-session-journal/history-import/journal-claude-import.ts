import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
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
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
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
}

export async function importClaudeTranscript(input: ClaudeImportInput) {
  input.signal?.throwIfAborted()
  const file = await ClaudeImportSource.open(input.filePath, input.signal)
  try {
    const prepared = await collectClaudeItems(file, input)
    return {
      ...prepared,
      verify: (refresh?: boolean) => file.verify(refresh),
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
  try {
    await file.scan((bytes, range) => {
      const row = readClaudeImportLinks(bytes)
      conversation ||= mayBeClaudeConversationEntry(row)
      if (row) {
        observer?.observeRecord(row)
        index.record(row, range)
      }
    })
    await index.select(check)
    let retained = 0
    window: for await (const batch of file.reread(index.ranges())) {
      for (const range of batch.ranges) {
        check()
        const offset = range.offset - batch.start
        const row = parseJsonObject(batch.bytes.toString('utf8', offset, offset + range.length))
        const message =
          row &&
          decodeClaudeTranscriptRecord(row, transcriptFallbackId(filePath, range.legacyOffset))
        if (message) {
          const identity = input.decodedMessageIdentities
            ? { provider: 'legacy' as const, agent, sessionId, recordId: message.id }
            : claudeLegacyIdentity(row, range.line, agent, sessionId)
          const item = Buffer.from(JSON.stringify(replacementItem(message, identity, input.limits)))
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
