import { mayBeClaudeConversationRecord } from '../../transcript-decoding/transcript-line-decoders-claude'
import type { ClaudeImportScratchOptions } from './journal-claude-import-scratch'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'
import { importClaudeTranscriptInWorker } from './journal-claude-import-worker'
import { createImportedForkTip, observeOmpForkTip } from './imported-fork-tip'
import {
  adoptedTranscriptSourceObserver,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type * as ids from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { readLegacyImportTranscript, TRANSCRIPT_DECODERS } from './journal-legacy-transcript-stream'
import { replacementItem } from './journal-replacement-items'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import { createNewestItemWindow } from './journal-newest-item-window'
import { createCodexHistoryCollector } from './journal-codex-history'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'

export const LEGACY_IMPORT_BLOCK_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }
const MAX_LEGACY_IMPORT_RECORD_BYTES = 16 * 1024 * 1024
// Keep only recent history in memory; the provider resumes the complete source transcript.
export const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024

export type PreparedLegacyImport =
  | {
      ok: true
      items: JournalReplacementItem[]
      sourceEmpty: boolean
      retainedBytes?: number
      forkTipItemIds?: string[]
      sourceFrontier?: string
      sourceConsumedBytes?: number
      sourceMtimeMs?: number
      sourceSkippedRecords?: number
      savedKeys?: string[][]
    }
  // cause keeps a typed adoption refusal for the caller.
  | { ok: false; error: string; cause?: unknown }

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

export async function prepareJsonlTranscriptImport(
  input: Parameters<typeof decodeJsonlReplacementItems>[0]
): Promise<
  | (Extract<PreparedLegacyImport, { ok: true }> & { retainedBytes: number })
  | Extract<PreparedLegacyImport, { ok: false }>
> {
  try {
    return { ok: true, ...(await decodeJsonlReplacementItems(input)) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cause: err }
  }
}

/** Bound during decode so memory follows retained history rather than source-file size. */
async function decodeJsonlReplacementItems(input: {
  filePath: string
  transcriptAgent: keyof typeof TRANSCRIPT_DECODERS
  agent: AgentType
  sessionId: string
  decodedMessageIdentities?: true
  source?: AdoptedTranscriptSource
  codexSessionsDirs?: string[]
  signal?: AbortSignal
  limits?: JournalPayloadLimits
  createCollector?: LegacyTranscriptCollectorFactory
  boundedClaude?: true
  maxBytes?: number
  claudeScratch?: ClaudeImportScratchOptions
}): Promise<{
  items: JournalReplacementItem[]
  retainedBytes: number
  sourceEmpty: boolean
  forkTipItemIds: string[]
  sourceFrontier?: string
  sourceConsumedBytes?: number
  sourceMtimeMs?: number
  sourceSkippedRecords?: number
  savedKeys?: string[][]
}> {
  if (input.transcriptAgent === 'claude') {
    try {
      // Only cloneable fields cross into the worker.
      return await importClaudeTranscriptInWorker({
        agent: input.agent,
        filePath: input.filePath,
        sessionId: input.sessionId,
        signal: input.signal,
        source: input.source,
        limits: input.limits ?? LEGACY_IMPORT_BLOCK_LIMITS,
        retainedBytes: MAX_LEGACY_IMPORT_RETAINED_BYTES,
        bounded: input.boundedClaude,
        maxBytes: input.maxBytes,
        decodedMessageIdentities: input.decodedMessageIdentities,
        scratch: input.claudeScratch
      })
    } catch (error) {
      // Without the spool a first open keeps the plain newest window; recovery keeps prior history.
      if (input.boundedClaude || !(error instanceof ClaudeImportResourceError)) {
        throw error
      }
    }
  }
  const source = input.source
    ? adoptedTranscriptSourceObserver({
        agent: input.transcriptAgent === 'claude' ? 'claude' : input.agent,
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
  const limits = input.limits ?? LEGACY_IMPORT_BLOCK_LIMITS
  const toItem = (message: NativeChatMessage, identity: ids.AgentJournalItemIdentity) =>
    replacementItem(message, identity, limits)
  const retained =
    input.transcriptAgent === 'codex'
      ? createCodexHistoryCollector(input.sessionId, limits, MAX_LEGACY_IMPORT_RETAINED_BYTES)
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
        roots: input.codexSessionsDirs,
        signal: input.signal
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
    return {
      items: retained.items(),
      retainedBytes: retained.retainedBytes(),
      sourceEmpty,
      forkTipItemIds: forkTip.settledItems()
    }
  } finally {
    collector?.close()
  }
}
