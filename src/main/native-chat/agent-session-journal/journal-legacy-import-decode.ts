import {
  decodeClaudeTranscriptRecord,
  decodeCodexTranscriptRecord,
  decodeGrokTranscriptRecord,
  decodeOmpTranscriptRecord
} from '../transcript-line-decoders'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createAdoptedTranscriptObservation,
  type AdoptedTranscriptObservation
} from './adopted-transcript-observation'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import { createPiTranscriptCollector } from './journal-pi-active-branch'
import { createNewestItemWindow } from './journal-newest-item-window'
import { legacyImportReplacementItem } from './journal-legacy-import-item'
import type {
  LegacyTranscriptImportRequest,
  PreparedLegacyImport
} from './journal-legacy-import-worker-protocol'

// Existing admission limits and newest-window semantics apply inside the decode worker.
const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024

const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptRecord,
  codex: (record: Record<string, unknown> | null, fallbackId: string) =>
    decodeCodexTranscriptRecord(record, fallbackId, { historyImport: true }),
  grok: decodeGrokTranscriptRecord,
  omp: decodeOmpTranscriptRecord
} as const

/** Bound during decode so memory follows retained history rather than source-file size. */
export async function decodeLegacyTranscriptImport(
  input: LegacyTranscriptImportRequest,
  validateSource: (observed: AdoptedTranscriptObservation) => Promise<void>
): Promise<PreparedLegacyImport> {
  const source = createAdoptedTranscriptObservation(input.agent, input.filePath)
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: input.transcriptAgent,
    agent: input.agent,
    sessionId: input.sessionId
  })
  const toItem = (message: NativeChatMessage, identity: AgentJournalItemIdentity) =>
    legacyImportReplacementItem(message, identity, input.limits)
  const retained = createNewestItemWindow(MAX_LEGACY_IMPORT_RETAINED_BYTES)
  const pi =
    input.agent === 'pi'
      ? createPiTranscriptCollector(toItem, (record, lineIndex) =>
          tracker.identify(record, lineIndex)
        )
      : null
  let lineIndex = 0
  try {
    const { consumedBytes } = await readLegacyImportTranscript(
      {
        filePath: input.filePath,
        codex: input.transcriptAgent === 'codex',
        roots: input.codexSessionsDirs
      },
      (line, fallbackId, record, recordId, selected = true) => {
        if (selected) {
          source.observe(record)
        }
        const currentLineIndex = lineIndex++
        if (pi) {
          pi.record(line, fallbackId, currentLineIndex, record)
          return null
        }
        const message = TRANSCRIPT_DECODERS[input.transcriptAgent](record, fallbackId)
        if (message) {
          retained.push(
            toItem(
              message,
              recordId || input.decodedMessageIdentities
                ? {
                    provider: 'legacy',
                    agent: input.agent,
                    sessionId: input.sessionId,
                    recordId: recordId ?? message.id
                  }
                : tracker.identify(record, currentLineIndex)
            )
          )
        }
        return null
      }
    )
    if (consumedBytes > 0 && input.validateSource) {
      await validateSource(source.observed)
    }
    if (pi) {
      await pi.project(retained.push)
    }
    return { ok: true, items: retained.items(), sourceEmpty: consumedBytes === 0 }
  } finally {
    pi?.close()
  }
}
