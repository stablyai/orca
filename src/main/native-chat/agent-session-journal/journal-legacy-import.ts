import type {
  LegacyImportOptions,
  LegacyImportResult,
  PreparedLegacyImport
} from './journal-legacy-import-contract'
import {
  LEGACY_IMPORT_BLOCK_LIMITS,
  replacementItem,
  replacementItems
} from './journal-legacy-import-body'
import {
  adoptedTranscriptSourceObserver,
  validateAdoptedOpenCodeSource,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { AgentType } from '../../../shared/agent-status-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import { resolveSessionFilePath } from '../session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from '../transcript-line-decoders'
import {
  decodePiTurnLifecycle,
  nativeChatTurnLifecycleDecoderForAgent
} from '../transcript-turn-lifecycle'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
import { readOpenCodeNativeChatTranscriptFull } from '../transcript-opencode'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import { createPiTranscriptCollector } from './journal-pi-active-branch'
import { readGrokTurnLifecycle } from '../transcript-grok-turn-lifecycle'
import { createNewestItemWindow } from './journal-newest-item-window'
import { createLatestTurnOpenerTracker } from './journal-legacy-turn-opener'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalPayloadLimits } from './journal-payload-bounds'
import type { AgentSessionJournal } from './journal-store'
export {
  type LegacyImportOptions,
  type LegacyImportResult,
  type PreparedLegacyImport
} from './journal-legacy-import-contract'

export {
  LEGACY_IMPORT_BLOCK_LIMITS,
  legacyItemBody,
  boundBlock
} from './journal-legacy-import-body'
// Build a fresh epoch: import-scoped legacy identities cannot safely share structured sequence space.

const MAX_LEGACY_IMPORT_RECORD_BYTES = 16 * 1024 * 1024
// Keep only recent history in memory; the provider resumes the complete source transcript.
const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024

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
  piAfterEntry?: string
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
    const { items, consumedBytes, ...turns } = await decodeReplacementItems({
      filePath,
      piAfterEntry: input.piAfterEntry,
      transcriptAgent,
      agent: input.agent,
      sessionId: input.sessionId,
      source: options.source,
      codexSessionsDirs: options.source?.conversationStore
        ? [options.source.conversationStore]
        : options.codexSessionsDirs,
      signal: options.signal,
      decodedMessageIdentities: options.decodedMessageIdentities,
      limits
    })
    return { ok: true, items, sourceEmpty: consumedBytes === 0, ...turns }
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
  return {
    ok: true,
    items,
    sourceEmpty: read.sourceEmpty === true,
    ...(read.lifecycle ? { latestTurn: read.lifecycle } : {})
  }
}

const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptLine,
  codex: (line: string, fallbackId: string) =>
    decodeCodexTranscriptLine(line, fallbackId, { historyImport: true }),
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
} as const

/** Bound during decode so memory follows retained history rather than source-file size. */
async function decodeReplacementItems(input: {
  filePath: string
  piAfterEntry?: string
  transcriptAgent: keyof typeof TRANSCRIPT_DECODERS
  agent: AgentType
  sessionId: string
  decodedMessageIdentities?: true
  source?: AdoptedTranscriptSource
  codexSessionsDirs?: string[]
  signal?: AbortSignal
  limits: JournalPayloadLimits
}): Promise<{
  items: JournalReplacementItem[]
  consumedBytes: number
  latestTurn?: NativeChatTurnLifecycle
  turnStates: ReadonlyMap<string, NativeChatTurnLifecycle>
  latestTurnAmbiguous?: true
  latestTurnOpener?: string | null
}> {
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
    sessionId: input.agent === 'pi' ? input.filePath : input.sessionId
  })
  const toItem = (message: NativeChatMessage, identity: AgentJournalItemIdentity) =>
    replacementItem(message, identity, input.limits)
  const retained = createNewestItemWindow(MAX_LEGACY_IMPORT_RETAINED_BYTES)
  const lifecycle =
    input.agent === 'pi'
      ? decodePiTurnLifecycle
      : nativeChatTurnLifecycleDecoderForAgent(input.agent, true)
  let latestTurn: NativeChatTurnLifecycle | undefined
  const turnStates = new Map<string, NativeChatTurnLifecycle>()
  // A legacy Claude reply may omit its stop reason: an open turn ending on such prose may be done.
  const loose =
    input.agent === 'claude' ? nativeChatTurnLifecycleDecoderForAgent(input.agent, false) : null
  let latestTurnAmbiguous = false
  // Pi's collector projects its rows after every boundary is read, so it supplies no opener.
  const opener = createLatestTurnOpenerTracker(input.agent !== 'pi')
  const observe = (line: string, fallbackId: string) => {
    const next = lifecycle?.(line, fallbackId)
    if (next) {
      opener.observe(next, latestTurn)
      latestTurn =
        next.state === 'working' || !latestTurn ? next : { ...next, turnId: latestTurn.turnId }
      turnStates.set(latestTurn.turnId, latestTurn)
      latestTurnAmbiguous = false
    } else if (loose && latestTurn?.state === 'working') {
      latestTurnAmbiguous ||= loose(line, fallbackId)?.state === 'completed'
    }
  }
  const pi =
    input.agent === 'pi'
      ? createPiTranscriptCollector(
          toItem,
          (line, lineIndex) => tracker.identify(line, lineIndex),
          observe
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
      (line, fallbackId, recordId, selected = true) => {
        if (selected) {
          source?.observe(line)
          if (!pi) {
            observe(line, fallbackId)
          }
        }
        const currentLineIndex = lineIndex
        lineIndex += 1
        if (pi) {
          pi.record(line, fallbackId, currentLineIndex)
          return null
        }
        const message = TRANSCRIPT_DECODERS[input.transcriptAgent](line, fallbackId)
        if (message) {
          retained.push(
            opener.seen(
              toItem(
                message,
                recordId || input.decodedMessageIdentities
                  ? {
                      provider: 'legacy',
                      agent: input.agent,
                      sessionId: input.sessionId,
                      recordId: recordId ?? message.id
                    }
                  : tracker.identify(line, currentLineIndex)
              )
            )
          )
        }
        return null
      }
    )
    if (consumedBytes > 0) {
      await source?.validate()
    }
    if (pi) {
      await pi.project(retained.push, input.piAfterEntry)
    }
    if (input.agent === 'grok') {
      latestTurn = await readGrokTurnLifecycle(input.filePath, input.sessionId)
      const user = retained
        .items()
        .findLast((item) => item.body.kind === 'message' && item.body.role === 'user')
      if (
        latestTurn &&
        latestTurn.state !== 'working' &&
        user?.observedAt != null &&
        latestTurn.timestamp != null &&
        latestTurn.timestamp < user.observedAt
      ) {
        latestTurn = undefined
      }
    }
    const ambiguous = latestTurnAmbiguous && latestTurn?.state === 'working'
    return {
      items: retained.items(),
      consumedBytes,
      turnStates,
      ...opener.evidence(latestTurn, retained.items()),
      ...(latestTurn ? { latestTurn } : {}),
      ...(ambiguous ? { latestTurnAmbiguous: true as const } : {})
    }
  } finally {
    pi?.close()
  }
}

/** Bound every bulk-bearing block, including mixed-message tool calls; the transcript retains full content. */
