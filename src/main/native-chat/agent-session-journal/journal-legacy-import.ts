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
import { putJournalBlob } from './journal-blob-store'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import {
  boundInlineText,
  boundPayload,
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

export type LegacyImportResult =
  | { ok: true; epoch: string; cursor: AgentJournalCursor; imported: number }
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
    const mapped = legacyItemBody(message, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    for (const blob of mapped.blobs) {
      await putJournalBlob(input.journal.directory, blob.digest, blob.payload)
    }
    await input.journal.appendItem(
      {
        provider: 'legacy',
        agent: input.agent,
        sessionId: input.sessionId,
        recordId: message.id
      },
      mapped.body,
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

  const replacement: JournalReplacementItem[] = []
  for (const [index, message] of decoded.messages.entries()) {
    const identity = decoded.identities[index]
    if (!identity) {
      continue
    }
    const mapped = legacyItemBody(message, limits)
    for (const blob of mapped.blobs) {
      await putJournalBlob(input.journal.directory, blob.digest, blob.payload)
    }
    replacement.push({
      identity,
      body: mapped.body,
      observedAt: message.timestamp ?? undefined
    })
  }
  const cursor = await input.journal.replaceEpochItems('legacy_import', input.fence, replacement)
  return { ok: true, epoch: cursor.epoch, cursor, imported: decoded.messages.length }
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

type MappedLegacyItem = {
  body: AgentJournalItemBody
  blobs: { digest: string; payload: string }[]
}

/**
 * A message whose only content is a tool invocation becomes a tool-call item so
 * the reducer renders it as one. Everything else stays a message item with its
 * blocks bounded in place.
 */
function legacyItemBody(
  message: NativeChatMessage,
  limits: JournalPayloadLimits
): MappedLegacyItem {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    return {
      body: { kind: 'tool-call', name: only.name, input: only.input, state: 'completed' },
      blobs: []
    }
  }
  if (only?.type === 'tool-result') {
    const output = boundPayload(only.output, limits)
    return {
      body: {
        kind: 'tool-call',
        name: 'tool-result',
        input: null,
        state: only.isError ? 'failed' : 'completed',
        output
      },
      blobs: output.truncated ? [{ digest: output.digest, payload: only.output }] : []
    }
  }
  return {
    body: {
      kind: 'message',
      role: message.role,
      blocks: message.blocks.map((block) => boundBlock(block, limits))
    },
    blobs: []
  }
}

/** Inline block text keeps only a bounded head plus an explicit marker. No blob
 *  is written: the marker carries the digest and byte length, and the source
 *  transcript remains the full copy — a blob here would be unreferenced by the
 *  render model and pruned at the next compaction. */
function boundBlock(block: NativeChatBlock, limits: JournalPayloadLimits): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: boundInlineText(block.text, limits).text }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: boundInlineText(block.output, limits).text }
  }
  return block
}
