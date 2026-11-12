import { createImportedForkTip, observeOmpForkTip } from './imported-fork-tip'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  adoptedTranscriptSourceObserver,
  validateAdoptedOpenCodeSource,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from '../../session-file-resolver'
import { decodedTranscriptMessages } from '../../transcript-stream-lines'
import { readLegacyImportTranscript, TRANSCRIPT_DECODERS } from './journal-legacy-transcript-stream'
import { readOpenCodeNativeChatTranscriptFull } from '../../transcript-opencode'
import { mayBeClaudeConversationRecord } from '../../transcript-line-decoders-claude'
import {
  createLegacyIdentityTracker,
  resolveDecodedLegacyMessageIdentity
} from './journal-legacy-identity'
import { createPiTranscriptCollector } from './journal-pi-active-branch'
import { createNewestItemWindow } from './journal-newest-item-window'
import { createCodexHistoryCollector } from './journal-codex-history'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import {
  boundLegacyImportBlock,
  boundToolInput,
  type JournalPayloadLimits
} from '../item-lifecycle/journal-payload-bounds'
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

export const LEGACY_IMPORT_BLOCK_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 16 * 1024 }

export type LegacyImportOptions = ResolveSessionFileOptions & {
  filePath?: string
  source?: AdoptedTranscriptSource
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
  signal?: AbortSignal
}

const MAX_LEGACY_IMPORT_RECORD_BYTES = 16 * 1024 * 1024
// Keep only recent history in memory; the provider resumes the complete source transcript.
const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024

export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: AgentJournalCursor
      imported: number
      replaced: boolean
    }
  | { ok: false; error: string }

type PreparedLegacyImport =
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean; forkTipItemIds?: string[] }
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
    const { items, sourceEmpty, forkTipItemIds } = await decodeReplacementItems({
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
      limits
    })
    return { ok: true, items, sourceEmpty, forkTipItemIds }
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

function replacementItems(
  messages: readonly NativeChatMessage[],
  identities: readonly AgentJournalItemIdentity[],
  limits: JournalPayloadLimits
): JournalReplacementItem[] {
  const replacement: JournalReplacementItem[] = []
  for (const [index, message] of messages.entries()) {
    const identity = identities[index]
    if (identity) {
      replacement.push(replacementItem(message, identity, limits))
    }
  }
  return replacement
}

function replacementItem(
  message: NativeChatMessage,
  identity: AgentJournalItemIdentity,
  limits: JournalPayloadLimits
): JournalReplacementItem {
  return {
    identity,
    body: legacyItemBody(message, limits),
    observedAt: message.timestamp ?? undefined,
    // Imported history belongs to no active generation, even when saved rows claim to be running.
    ownerFence: 0
  }
}

/** Bound during decode so memory follows retained history rather than source-file size. */
async function decodeReplacementItems(input: {
  filePath: string
  transcriptAgent: keyof typeof TRANSCRIPT_DECODERS
  agent: AgentType
  sessionId: string
  decodedMessageIdentities?: true
  source?: AdoptedTranscriptSource
  codexSessionsDirs?: string[]
  signal?: AbortSignal
  limits: JournalPayloadLimits
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
  const toItem = (message: NativeChatMessage, identity: AgentJournalItemIdentity) =>
    replacementItem(message, identity, input.limits)
  const retained =
    input.transcriptAgent === 'codex'
      ? createCodexHistoryCollector(input.sessionId, input.limits, MAX_LEGACY_IMPORT_RETAINED_BYTES)
      : createNewestItemWindow(MAX_LEGACY_IMPORT_RETAINED_BYTES)
  let paginated = false
  const pi =
    input.agent === 'pi'
      ? createPiTranscriptCollector(toItem, (line, lineIndex) => tracker.identify(line, lineIndex))
      : null
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
        if (pi) {
          pi.record(line, fallbackId, currentLineIndex)
          return null
        }
        const decoded = TRANSCRIPT_DECODERS[input.transcriptAgent](line, fallbackId)
        conversation ||= !!decoded || mayBeClaudeConversationRecord(line)
        for (const message of decodedTranscriptMessages(decoded)) {
          const identity = resolveDecodedLegacyMessageIdentity(tracker, line, currentLineIndex, {
            ...input,
            messageId: message.id,
            role: message.role,
            splitLine: Array.isArray(decoded),
            recordId
          })
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
    if (pi) {
      await pi.project(retained.push)
    }
    const sourceEmpty = consumedBytes === 0 || !conversation
    return { items: retained.items(), sourceEmpty, forkTipItemIds: forkTip.settledItems() }
  } finally {
    pi?.close()
  }
}

export function legacyItemBody(
  message: NativeChatMessage,
  limits?: JournalPayloadLimits
): AgentJournalItemBody {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    // Bound adoption before epoch publication; catch-up uses whole-batch admission.
    return {
      kind: 'tool-call',
      name: only.name,
      input: limits ? boundToolInput(only.input, limits) : only.input,
      ...(only.callId !== undefined ? { callId: only.callId } : {}),
      state: 'completed'
    }
  }
  return {
    kind: 'message',
    role: message.role,
    blocks: limits
      ? message.blocks.map((block) => boundLegacyImportBlock(block, limits))
      : message.blocks
  }
}
