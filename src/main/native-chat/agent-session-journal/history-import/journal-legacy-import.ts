import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  validateAdoptedOpenCodeSource,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type * as ids from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from '../../session-file-resolver'
import { readOpenCodeNativeChatTranscriptFull } from '../../transcript-history/opencode/transcript-opencode'
import { prepareHermesImport } from './journal-hermes-import'
import { prepareAntigravityImport } from './journal-antigravity-import'
import { prepareDroidImport } from './journal-droid-import'
import { prepareKimiImport } from './journal-kimi-import'
import { replacementItems } from './journal-replacement-items'
import { decodeJsonlReplacementItems } from './journal-jsonl-import'
import {
  LEGACY_IMPORT_BLOCK_LIMITS,
  MAX_LEGACY_IMPORT_RETAINED_BYTES
} from './journal-transcript-import-limits'
import { createPiTranscriptCollector } from './journal-pi-active-branch'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import type { JournalPayloadLimits } from '../item-lifecycle/journal-payload-bounds'
import type { AgentSessionJournal } from '../journal-store'
// Hydrating a journal from a bridge-era transcript.
//
// Ordinary messages reuse the existing per-agent transcript decoders; Pi also
// projects its saved branch and summaries. The decoders return a render model
// with no identity, so the import wraps them: the wrapper
// reads an identity anchor off the SAME raw line, then delegates the content.
//
// Import replaces provider presentation at a context boundary. Canonical input stays in the
// ordered log; later structured history replaces only this reconstructed presentation.

export { LEGACY_IMPORT_BLOCK_LIMITS } from './journal-transcript-import-limits'

export type LegacyImportOptions = ResolveSessionFileOptions & {
  filePath?: string
  source?: AdoptedTranscriptSource
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
  signal?: AbortSignal
}

export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: ids.AgentJournalCursor
      imported: number
      replaced: boolean
    }
  | { ok: false; error: string }

type PreparedLegacyImport =
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean; forkTipItemIds?: string[] }
  // cause keeps a typed adoption refusal for the caller.
  | { ok: false; error: string; cause?: unknown }

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
  const { cursor } = await input.journal.write({
    kind: 'epoch-replace',
    reason: 'legacy_import',
    fence: input.fence,
    items: prepared.items
  })
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
  if (input.agent === 'hermes') {
    return prepareHermesImport(input.sessionId, options, limits, MAX_LEGACY_IMPORT_RETAINED_BYTES)
  }
  if (input.agent === 'antigravity') {
    return prepareAntigravityImport(
      input.sessionId,
      options,
      limits,
      MAX_LEGACY_IMPORT_RETAINED_BYTES
    )
  }
  if (input.agent === 'kimi') {
    return prepareKimiImport(input.sessionId, options, limits, MAX_LEGACY_IMPORT_RETAINED_BYTES)
  }
  if (input.agent === 'droid') {
    return prepareDroidImport(input.sessionId, options, limits, MAX_LEGACY_IMPORT_RETAINED_BYTES)
  }
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
    const { items, sourceEmpty, forkTipItemIds } = await decodeJsonlReplacementItems({
      filePath,
      transcriptAgent,
      agent: input.agent,
      sessionId: input.sessionId,
      source: options.source,
      codexSessionsDirs: options.source?.conversationStore
        ? [options.source.conversationStore]
        : options.codexSessionsDirs,
      signal: options.signal,
      decodedMessageIdentities: options.decodedMessageIdentities,
      limits,
      createCollector: input.agent === 'pi' ? createPiTranscriptCollector : undefined
    })
    return { ok: true, items, sourceEmpty, forkTipItemIds }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cause: err }
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
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), cause: err }
    }
  }
  const read = await readOpenCodeNativeChatTranscriptFull(
    input.sessionId,
    dbPath ? { resolveDbPath: async () => dbPath } : {}
  )
  if ('error' in read) {
    return { ok: false, error: read.error }
  }
  const identities = read.messages.map((message): ids.AgentJournalItemIdentity => ({
    provider: 'legacy',
    agent: input.agent,
    sessionId: input.sessionId,
    recordId: message.id
  }))
  const items = replacementItems(read.messages, identities, input.limits)
  return {
    ok: true,
    items,
    sourceEmpty: read.sourceEmpty === true,
    forkTipItemIds: read.forkTipItemIds?.map((recordId) =>
      agentJournalItemKey({
        provider: 'legacy',
        agent: input.agent,
        sessionId: input.sessionId,
        recordId
      })
    )
  }
}
