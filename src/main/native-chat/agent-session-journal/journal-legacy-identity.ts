// Identity anchors for bridge-era transcript lines.
//
// The transcript decoders return a render model, not an identity, so the import
// reads identity from the SAME raw line the decoder consumed rather than
// inferring it from decoded text.
//
// Claude gets its real identity namespace: the project jsonl IS the provider's
// store, and `uuid` survives `--fork-session` unchanged, so a later structured
// session reconciles against these keys directly.
//
// Codex, Grok, and omp get the `legacy` namespace. A Codex rollout file records
// `response_item` ids (`msg_…`, `rs_…`, `ctc_…`) which are a different namespace
// from the app-server's positional `item-N` ordinals, and rollout records carry
// no turn id at all — so a rollout line cannot be expressed as a stable
// `(threadId, turnId, ordinal)` key without guessing. Legacy items are therefore
// import-scoped, and a later structured resume rolls the epoch and rebuilds.

import type { AgentType } from '../../../shared/agent-status-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { NativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'

export type LegacyIdentityTracker = {
  /** Identity for whatever the decoder emits from this raw line. Called for
   *  every line in file order, including ones the decoder discards. */
  identify(line: string, lineIndex: number): AgentJournalItemIdentity
}

export function createLegacyIdentityTracker(input: {
  transcriptAgent: NativeChatTranscriptAgent
  agent: AgentType
  sessionId: string
}): LegacyIdentityTracker {
  if (input.transcriptAgent === 'claude') {
    return { identify: (line, index) => claudeIdentity(line, index, input.agent, input.sessionId) }
  }
  return {
    identify: (line, index) => ({
      provider: 'legacy',
      agent: input.agent,
      sessionId: input.sessionId,
      recordId: legacyRecordId(line, index)
    })
  }
}

function claudeIdentity(
  line: string,
  lineIndex: number,
  agent: AgentType,
  sessionId: string
): AgentJournalItemIdentity {
  const record = parseRecord(line)
  const uuid = stringField(record, 'uuid')
  if (!uuid) {
    return { provider: 'legacy', agent, sessionId, recordId: `#${lineIndex}` }
  }
  // The record's own session id wins: a forked transcript keeps the original
  // item uuids, and pairing them with the fork's id would mint new identities.
  return { provider: 'claude', sessionId: stringField(record, 'sessionId') ?? sessionId, uuid }
}

/** `payload.id` when the record carries one, else the line's position. Position
 *  is deterministic for a given import of a given file, which is all the legacy
 *  namespace promises. */
function legacyRecordId(line: string, lineIndex: number): string {
  const record = parseRecord(line)
  const payload = record?.payload
  const id = stringField(payload, 'id') ?? stringField(record, 'id') ?? stringField(record, 'uuid')
  return id ?? `#${lineIndex}`
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}
