import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type * as ids from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { mayBeClaudeConversationRecord } from '../../transcript-decoding/transcript-line-decoders-claude'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import { createImportedForkTip, observeOmpForkTip } from './imported-fork-tip'
import { createCodexHistoryCollector } from './journal-codex-history'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import {
  MAX_LEGACY_IMPORT_RECORD_BYTES,
  readLegacyImportTranscript,
  TRANSCRIPT_DECODERS
} from './journal-legacy-transcript-stream'
import { createNewestItemWindow } from './journal-newest-item-window'
import { replacementItem } from './journal-replacement-items'
import { MAX_LEGACY_IMPORT_RETAINED_BYTES } from './journal-transcript-import-limits'

type LegacyTranscriptCollectorFactory = (
  toItem: (
    message: NativeChatMessage,
    identity: ids.AgentJournalItemIdentity
  ) => JournalReplacementItem,
  identify: (line: string, lineIndex: number) => ids.AgentJournalItemIdentity
) => {
  record(line: string, fallbackId: string, lineIndex: number): void
  project(keep: (item: JournalReplacementItem) => void): Promise<void>
  close(): void
}

/** Bound during decode so memory follows retained history rather than source-file size. */
export async function decodeJsonlReplacementItems(input: {
  filePath: string
  transcriptAgent: keyof typeof TRANSCRIPT_DECODERS
  agent: AgentType
  sessionId: string
  decodedMessageIdentities?: true
  source?: AdoptedTranscriptSource
  codexSessionsDirs?: string[]
  signal?: AbortSignal
  limits: JournalPayloadLimits
  createCollector?: LegacyTranscriptCollectorFactory
}): Promise<{ items: JournalReplacementItem[]; sourceEmpty: boolean; forkTipItemIds: string[] }> {
  const source = input.source
    ? adoptedTranscriptSourceObserver({
        agent: input.agent,
        filePath: input.filePath,
        source: input.source,
        signal: input.signal,
        maxSourceBytes: MAX_LEGACY_IMPORT_RECORD_BYTES
      })
    : null
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: input.transcriptAgent,
    agent: input.agent,
    sessionId: input.sessionId
  })
  const toItem = (message: NativeChatMessage, identity: ids.AgentJournalItemIdentity) =>
    replacementItem(message, identity, input.limits)
  const retained =
    input.transcriptAgent === 'codex'
      ? createCodexHistoryCollector(input.sessionId, input.limits, MAX_LEGACY_IMPORT_RETAINED_BYTES)
      : createNewestItemWindow(MAX_LEGACY_IMPORT_RETAINED_BYTES)
  let paginated = false
  const collector = input.createCollector?.(toItem, (line, lineIndex) =>
    tracker.identify(line, lineIndex)
  )
  const forkTip = createImportedForkTip()
  let lineIndex = 0
  // A Claude file of metadata alone is one nothing was sent in; an undecodable turn still counts.
  let conversation = input.transcriptAgent !== 'claude'
  try {
    const { consumedBytes } = await readLegacyImportTranscript(
      {
        filePath: input.filePath,
        codex: input.transcriptAgent === 'codex',
        roots: input.codexSessionsDirs
      },
      (line, fallbackId, recordId, selected = true) => {
        if (selected) {
          source?.observe(line)
        }
        if (paginated) {
          return null
        }
        const currentLineIndex = lineIndex++
        if (collector) {
          collector.record(line, fallbackId, currentLineIndex)
          return null
        }
        const message = TRANSCRIPT_DECODERS[input.transcriptAgent](line, fallbackId)
        conversation ||= !!message || mayBeClaudeConversationRecord(line)
        if (message) {
          const identity =
            recordId || input.decodedMessageIdentities
              ? {
                  provider: 'legacy' as const,
                  agent: input.agent,
                  sessionId: input.sessionId,
                  recordId: recordId ?? message.id
                }
              : tracker.identify(line, currentLineIndex)
          retained.push(toItem(message, identity))
        }
        if (input.transcriptAgent === 'omp') {
          observeOmpForkTip(forkTip, line, tracker.identify(line, currentLineIndex))
        }
        return null
      },
      'record' in retained
        ? (descriptor) => {
            paginated = descriptor.paginated
            retained.record(descriptor)
          }
        : undefined
    )
    // A file with no conversation adopts nothing, so it has no identity to prove.
    if (consumedBytes > 0 && conversation) {
      await source?.validate()
    }
    if (collector) {
      await collector.project(retained.push)
    }
    const sourceEmpty = consumedBytes === 0 || !conversation
    return { items: retained.items(), sourceEmpty, forkTipItemIds: forkTip.settledItems() }
  } finally {
    collector?.close()
  }
}
