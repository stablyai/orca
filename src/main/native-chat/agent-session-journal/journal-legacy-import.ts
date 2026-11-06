import {
  validateAdoptedTranscriptSource,
  validateAdoptedOpenCodeSource,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from '../session-file-resolver'
import { readOpenCodeNativeChatTranscriptFull } from '../transcript-opencode'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalPayloadLimits } from './journal-payload-bounds'
import { legacyImportReplacementItem } from './journal-legacy-import-item'
import { runLegacyTranscriptImportWorker } from './journal-legacy-import-worker'
import type { PreparedLegacyImport } from './journal-legacy-import-worker-protocol'
export { legacyItemBody } from './journal-legacy-import-item'
import type { AgentSessionJournal } from './journal-store'
// Hydrating a journal from a bridge-era transcript.
//
// Ordinary messages reuse the existing per-agent transcript decoders; Pi also
// projects its saved branch and summaries. The decoders return a render model
// with no identity, so the import wraps them: the wrapper
// reads an identity anchor off the SAME raw line, then delegates the content.
//
// Import replaces provider presentation at a context boundary. Canonical input stays in the
// ordered log; later structured history replaces only this reconstructed presentation.

export const LEGACY_IMPORT_BLOCK_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

export type LegacyImportOptions = ResolveSessionFileOptions & {
  filePath?: string
  source?: AdoptedTranscriptSource
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
  signal?: AbortSignal
}

const MAX_LEGACY_IMPORT_RECORD_BYTES = 16 * 1024 * 1024
export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: AgentJournalCursor
      imported: number
      replaced: boolean
    }
  | { ok: false; error: string }

export async function importLegacyTranscriptIntoJournal(input: {
  journal: AgentSessionJournal
  agent: AgentType
  sessionId: string
  fence: number
  options?: LegacyImportOptions
}): Promise<LegacyImportResult> {
  const prepared = await prepareLegacyTranscriptImport(input)
  if (!prepared.ok) {
    return prepared
  }
  if (prepared.items.length === 0) {
    const current = input.journal.cursor()
    return { ok: true, epoch: current.epoch, cursor: current, imported: 0, replaced: false }
  }
  const cursor = await input.journal.replaceEpochItems('legacy_import', input.fence, prepared.items)
  return { ok: true, epoch: cursor.epoch, cursor, imported: prepared.items.length, replaced: true }
}

export async function prepareLegacyTranscriptImport(input: {
  agent: AgentType
  sessionId: string
  options?: LegacyImportOptions
}): Promise<PreparedLegacyImport> {
  const options = input.options ?? {}
  const limits = options.limits ?? LEGACY_IMPORT_BLOCK_LIMITS
  // OMP retained Pi's format, so its decoder also reads Pi sessions.
  const transcriptAgent =
    input.agent === 'pi' ? 'omp' : resolveNativeChatTranscriptAgent(input.agent)
  if (!transcriptAgent) {
    return { ok: false, error: `Unsupported agent for journal import: ${input.agent}` }
  }
  if (transcriptAgent === 'opencode') {
    return prepareOpenCodeImport({ ...input, limits })
  }
  const filePath =
    options.filePath ?? (await resolveSessionFilePath(input.agent, input.sessionId, options))
  if (!filePath) {
    return { ok: false, error: `No transcript found for ${input.agent} session ${input.sessionId}` }
  }

  try {
    return await runLegacyTranscriptImportWorker(
      {
        filePath,
        transcriptAgent,
        agent: input.agent,
        sessionId: input.sessionId,
        validateSource: options.source !== undefined,
        codexSessionsDirs: options.source?.conversationStore
          ? [options.source.conversationStore]
          : options.codexSessionsDirs,
        decodedMessageIdentities: options.decodedMessageIdentities,
        limits
      },
      async (observed, signal) => {
        if (options.source) {
          await validateAdoptedTranscriptSource({
            agent: input.agent,
            filePath,
            source: options.source,
            maxSourceBytes: MAX_LEGACY_IMPORT_RECORD_BYTES,
            observed,
            signal
          })
        }
      },
      options.signal
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// OpenCode database message IDs are stable; reuse the existing transcript reader.
async function prepareOpenCodeImport(input: {
  agent: AgentType
  sessionId: string
  options?: LegacyImportOptions
  limits: JournalPayloadLimits
}): Promise<PreparedLegacyImport> {
  const dbPath = input.options?.filePath
  if (input.options?.source) {
    if (!dbPath) {
      return { ok: false, error: 'The conversation database is unavailable.' }
    }
    try {
      await validateAdoptedOpenCodeSource(dbPath, input.options.source, input.options.signal)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const read = await readOpenCodeNativeChatTranscriptFull(
    input.sessionId,
    dbPath ? { resolveDbPath: async () => dbPath } : {}
  )
  if ('error' in read) {
    return { ok: false, error: read.error }
  }
  const identities = read.messages.map((message): AgentJournalItemIdentity => ({
    provider: 'legacy',
    agent: input.agent,
    sessionId: input.sessionId,
    recordId: message.id
  }))
  const items = replacementItems(read.messages, identities, input.limits)
  return { ok: true, items, sourceEmpty: read.sourceEmpty === true }
}

function replacementItems(
  messages: readonly NativeChatMessage[],
  identities: readonly AgentJournalItemIdentity[],
  limits: JournalPayloadLimits
): JournalReplacementItem[] {
  const replacement: JournalReplacementItem[] = []
  for (const [index, message] of messages.entries()) {
    const identity = identities[index]
    if (identity) {
      replacement.push(legacyImportReplacementItem(message, identity, limits))
    }
  }
  return replacement
}
