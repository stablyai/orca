import {
  decodeClaudeTranscriptRecordWork,
  decodeCodexTranscriptRecordWork,
  decodeGrokTranscriptRecordWork,
  decodeOmpTranscriptRecordWork
} from '../transcript-line-decoders'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createAdoptedTranscriptObservation,
  type AdoptedTranscriptObservation
} from './adopted-transcript-observation'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import {
  createPiTranscriptCollector,
  decodePiSessionEntryRecordWork
} from './journal-pi-active-branch'
import { createNewestItemWindow } from './journal-newest-item-window'
import {
  legacyImportReplacementItem,
  legacyImportReplacementItemWork
} from './journal-legacy-import-item'
import { createTranscriptWorkScheduler } from '../transcript-work-scheduler'
import { parseTranscriptRecordWork } from '../transcript-record-parser'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import type {
  LegacyTranscriptImportRequest,
  PreparedLegacyImport
} from './journal-legacy-import-types'

// Existing admission limits and newest-window semantics apply during preparation.
const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024

const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptRecordWork,
  codex: (record: Record<string, unknown> | null, fallbackId: string) =>
    decodeCodexTranscriptRecordWork(record, fallbackId, { historyImport: true }),
  grok: decodeGrokTranscriptRecordWork,
  omp: decodeOmpTranscriptRecordWork
} as const

/** Bound during decode so memory follows retained history rather than source-file size. */
export async function decodeLegacyTranscriptImport(
  input: LegacyTranscriptImportRequest,
  validateSource: (observed: AdoptedTranscriptObservation) => Promise<void>
): Promise<PreparedLegacyImport> {
  throwIfSignalAborted(input.signal)
  const run = createTranscriptWorkScheduler(input.signal)
  const parseRecord = (line: string) => run(parseTranscriptRecordWork(line))
  const source = createAdoptedTranscriptObservation(input.agent, input.filePath)
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: input.transcriptAgent,
    agent: input.agent,
    sessionId: input.sessionId
  })
  const toItem = (message: NativeChatMessage, identity: AgentJournalItemIdentity) =>
    run(legacyImportReplacementItemWork(message, identity, input.limits))
  const retained = createNewestItemWindow(MAX_LEGACY_IMPORT_RETAINED_BYTES)
  const pi =
    input.agent === 'pi'
      ? createPiTranscriptCollector(
          (message, identity) => legacyImportReplacementItem(message, identity, input.limits),
          (record, lineIndex) => tracker.identify(record, lineIndex)
        )
      : null
  let lineIndex = 0
  try {
    const { consumedBytes } = await readLegacyImportTranscript(
      {
        filePath: input.filePath,
        codex: input.transcriptAgent === 'codex',
        roots: input.codexSessionsDirs,
        parseRecord,
        signal: input.signal
      },
      async (line, fallbackId, record, recordId, selected = true) => {
        if (selected) {
          source.observe(record)
        }
        const currentLineIndex = lineIndex++
        if (pi) {
          pi.record(line, fallbackId, currentLineIndex, record)
          return null
        }
        const message = await run(TRANSCRIPT_DECODERS[input.transcriptAgent](record, fallbackId))
        if (message) {
          const prepared = await toItem(
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
          await run(retained.pushWork(prepared.item, prepared.bytes))
        }
        return null
      }
    )
    throwIfSignalAborted(input.signal)
    if (consumedBytes > 0 && input.validateSource) {
      await validateSource(source.observed)
    }
    throwIfSignalAborted(input.signal)
    if (pi) {
      await pi.project(
        retained.push,
        async (line, fallbackId, lineIndex) => {
          const record = await parseRecord(line)
          const message = await run(decodePiSessionEntryRecordWork(record, fallbackId))
          if (message) {
            const prepared = await toItem(message, tracker.identify(record, lineIndex))
            await run(retained.pushWork(prepared.item, prepared.bytes))
          }
        },
        input.signal
      )
    }
    const items = await run(retained.itemsWork())
    throwIfSignalAborted(input.signal)
    return { ok: true, items, sourceEmpty: consumedBytes === 0 }
  } finally {
    pi?.close()
  }
}
