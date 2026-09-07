// Hydrating a journal from a bridge-era transcript.
//
// This reuses the existing per-agent transcript decoders verbatim — a second
// parser would drift from the one the live view already uses. The decoders
// return a render model with no identity, so the import wraps them: the wrapper
// reads an identity anchor off the SAME raw line, then delegates the content.
//
// Import always opens a fresh epoch. The imported timeline is a best-effort
// reconstruction with import-scoped identities for most providers, so it must
// never be spliced into a sequence space that a structured session is also
// writing; a later structured resume rolls the epoch again and rebuilds.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { AgentType } from '../../../shared/agent-status-types'
import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from '../session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from '../transcript-line-decoders'
import { decodeTranscriptStream } from '../transcript-stream-lines'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import {
  boundInlineText,
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from './journal-payload-bounds'
import type { AgentSessionJournal } from './journal-store'

export type LegacyImportOptions = ResolveSessionFileOptions & {
  /** Resolve directly to this file, skipping path discovery. */
  filePath?: string
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
}

const MAX_LEGACY_IMPORT_SOURCE_BYTES = 16 * 1024 * 1024

export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: AgentJournalCursor
      imported: number
      /** False when the transcript held no messages and the epoch was left as it stood. */
      replaced: boolean
    }
  | { ok: false; error: string }

export async function appendLegacyTranscriptMessages(input: {
  journal: AgentSessionJournal
  agent: AgentType
  sessionId: string
  fence: number
  messages: NativeChatMessage[]
}): Promise<number> {
  let appended = 0
  for (const message of input.messages) {
    await input.journal.appendItem(
      {
        provider: 'legacy',
        agent: input.agent,
        sessionId: input.sessionId,
        recordId: message.id
      },
      legacyItemBody(message, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      { fence: input.fence, observedAt: message.timestamp ?? undefined }
    )
    appended += 1
  }
  return appended
}

export async function importLegacyTranscriptIntoJournal(input: {
  journal: AgentSessionJournal
  agent: AgentType
  sessionId: string
  fence: number
  options?: LegacyImportOptions
}): Promise<LegacyImportResult> {
  const options = input.options ?? {}
  const limits = options.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
  const transcriptAgent = resolveNativeChatTranscriptAgent(input.agent)
  if (!transcriptAgent) {
    return { ok: false, error: `Unsupported agent for journal import: ${input.agent}` }
  }
  const filePath =
    options.filePath ?? (await resolveSessionFilePath(input.agent, input.sessionId, options))
  if (!filePath) {
    return { ok: false, error: `No transcript found for ${input.agent} session ${input.sessionId}` }
  }

  // Refuse an oversized source before decoding any prefix. Importing a prefix
  // would make the restored timeline look complete while silently omitting
  // later records; callers can retry after reducing the source or quota.
  try {
    const sourceBytes = (await stat(filePath)).size
    if (sourceBytes > MAX_LEGACY_IMPORT_SOURCE_BYTES) {
      return {
        ok: false,
        error: `Legacy transcript exceeds the ${MAX_LEGACY_IMPORT_SOURCE_BYTES}-byte import bound`
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  let decoded: { messages: NativeChatMessage[]; identities: AgentJournalItemIdentity[] }
  try {
    decoded = await decodeWithIdentities({
      filePath,
      transcriptAgent,
      agent: input.agent,
      sessionId: input.sessionId,
      decodedMessageIdentities: options.decodedMessageIdentities
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  if (decoded.identities.length !== decoded.messages.length) {
    return { ok: false, error: 'Legacy transcript identity coverage is incomplete' }
  }
  const replacement: JournalReplacementItem[] = []
  for (const [index, message] of decoded.messages.entries()) {
    const identity = decoded.identities[index]
    if (!identity) {
      continue
    }
    replacement.push({
      identity,
      body: legacyItemBody(message, limits),
      observedAt: message.timestamp ?? undefined
    })
  }
  // A transcript that decodes to nothing reconstructs nothing, and an empty
  // replacement is not a harmless no-op: it would delete the repair's anchor and
  // its disclosure, leaving nothing to ask for the history again. The epoch
  // stands so a later read can still rebuild it.
  if (replacement.length === 0) {
    const current = input.journal.cursor()
    return { ok: true, epoch: current.epoch, cursor: current, imported: 0, replaced: false }
  }
  const cursor = await input.journal.replaceEpochItems('legacy_import', input.fence, replacement)
  return {
    ok: true,
    epoch: cursor.epoch,
    cursor,
    imported: decoded.messages.length,
    replaced: true
  }
}

const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptLine,
  codex: decodeCodexTranscriptLine,
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
} as const

/** Run the real decoder while recording an identity anchor per emitted message,
 *  index-aligned with `messages`. */
async function decodeWithIdentities(input: {
  filePath: string
  transcriptAgent: keyof typeof TRANSCRIPT_DECODERS
  agent: AgentType
  sessionId: string
  decodedMessageIdentities?: true
}): Promise<{ messages: NativeChatMessage[]; identities: AgentJournalItemIdentity[] }> {
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: input.transcriptAgent,
    agent: input.agent,
    sessionId: input.sessionId
  })
  const decode = TRANSCRIPT_DECODERS[input.transcriptAgent]
  const identities: AgentJournalItemIdentity[] = []
  let lineIndex = 0

  const stream = createReadStream(input.filePath, { encoding: 'utf-8' })
  const { messages } = await decodeTranscriptStream(
    stream,
    input.filePath,
    0,
    (line, fallbackId) => {
      const trackedIdentity = tracker.identify(line, lineIndex)
      lineIndex += 1
      const message = decode(line, fallbackId)
      if (message) {
        identities.push(
          input.decodedMessageIdentities
            ? {
                provider: 'legacy',
                agent: input.agent,
                sessionId: input.sessionId,
                recordId: message.id
              }
            : trackedIdentity
        )
      }
      return message
    },
    true
  )
  return { messages, identities }
}

/**
 * A message whose only content is a tool invocation becomes a tool-call item so
 * the reducer renders it as one. Everything else stays a message item with its
 * blocks bounded in place.
 */
function legacyItemBody(
  message: NativeChatMessage,
  limits: JournalPayloadLimits
): AgentJournalItemBody {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    // Legacy transcripts are untrusted and can contain arbitrarily large tool
    // arguments. Keep them on the same bounded path as live events before the
    // replacement epoch is published.
    return {
      kind: 'tool-call',
      name: only.name,
      input: boundToolInput(only.input, limits),
      state: 'completed'
    }
  }
  if (only?.type === 'tool-result') {
    return {
      kind: 'tool-call',
      name: 'tool-result',
      input: null,
      state: only.isError ? 'failed' : 'completed',
      output: boundPayload(only.output, limits)
    }
  }
  return {
    kind: 'message',
    role: message.role,
    blocks: message.blocks.map((block) => boundBlock(block, limits))
  }
}

/** Every block that can carry untrusted bulk is bounded here, tool calls
 *  included: a provider decoder is free to put one alongside narration, and the
 *  sole-block path above never sees those. The remainder is discarded rather
 *  than stored elsewhere — the marker keeps its digest and byte length, and the
 *  source transcript remains the full copy. */
function boundBlock(block: NativeChatBlock, limits: JournalPayloadLimits): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: boundInlineText(block.text, limits).text }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: boundInlineText(block.output, limits).text }
  }
  if (block.type === 'tool-call') {
    return { ...block, input: boundToolInput(block.input, limits) }
  }
  return block
}
