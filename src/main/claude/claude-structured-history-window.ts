// Provider history for restart reconciliation, read from the Claude project JSONL.
//
// Why this file is the source of truth for "did Claude take it": a resume replays
// this transcript by session id, so a message absent from it is absent from the
// conversation Orca is about to resume. Absence here is not an inference about a
// dead child — it is the content of the next turn's context.
//
// The window is anchored on the leaf uuid Orca durably recorded for the session.
// Without that anchor the read has no proven start, and the branch proof is what
// decides whether the file we just read still descends from it: a fork, a
// compaction, a sibling branch, or a torn tail all fail the proof, and every one
// of those makes absence meaningless. Failing it reports an inconsistent
// boundary rather than an empty window, because the two decide opposite things.

import { readFile, stat } from 'node:fs/promises'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type {
  ProviderHistoryItem,
  ProviderHistoryWindow
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { claudeContentBlocks } from '../native-chat/transcript-record-blocks'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { proveClaudeTranscriptBranchFromJsonl } from './claude-transcript-branch-proof'

/** Matches the legacy-import bound: a prefix read would make absence meaningless. */
const MAX_HISTORY_WINDOW_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_HISTORY_WINDOW_WALK = 10_000

const INCONSISTENT: ProviderHistoryWindow = {
  items: [],
  boundaryConsistent: false,
  turnInFlight: false
}

type TranscriptRecord = Record<string, unknown>

function stringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function isPlainTextPart(part: unknown): boolean {
  if (typeof part === 'string') {
    return true
  }
  return Boolean(part) && typeof part === 'object' && (part as TranscriptRecord).type === 'text'
}

/**
 * A user record Orca could itself have submitted. Everything the harness injects
 * is excluded, because a fingerprint computed over machinery would claim a
 * history slot the user's message should have had.
 *
 * Attachments are excluded too, and deliberately: the transcript keeps a pasted
 * image as base64 with no path, so the `image-ref` block the submission was
 * fingerprinted from cannot be reconstructed. Measured over 2,764 genuine prompt
 * records in 12 local transcripts, every multi-block prompt was exactly
 * text + image; none carried injected content.
 */
function claudePromptBlocks(record: TranscriptRecord): NativeChatBlock[] | null {
  if (
    record.type !== 'user' ||
    record.isSidechain === true ||
    record.parent_tool_use_id != null ||
    record.isMeta === true ||
    record.isSynthetic === true ||
    record.isCompactSummary === true
  ) {
    return null
  }
  const message = record.message
  const content =
    message && typeof message === 'object' ? (message as TranscriptRecord).content : undefined
  // Read the RAW parts, not the decoded ones: a base64 image decodes to nothing
  // at all, so a prompt with an attachment would otherwise pass as text-only and
  // be fingerprinted as if the attachment had never been sent.
  if (Array.isArray(content) && !content.every((part) => isPlainTextPart(part))) {
    return null
  }
  const blocks = claudeContentBlocks(content)
  if (blocks.length === 0 || blocks.some((block) => block.type !== 'text')) {
    return null
  }
  const [first] = blocks
  if (first?.type !== 'text' || isKnownHarnessInjectedUserTurnText(first.text)) {
    return null
  }
  return blocks
}

/**
 * The digest the submission row is GUARANTEED to carry. `admitAndRunAgentSessionMutation`
 * recomputes this exact call over the send's own body and refuses the send on a
 * mismatch, and `performSend` is the only writer of a submission row — so the
 * stored fingerprint is this function's output over the stored body, whoever
 * produced the envelope. Matching here is therefore an equality between two runs
 * of one function, not a guess about two encodings agreeing.
 */
function promptFingerprint(sessionId: string, blocks: NativeChatBlock[]): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body: { kind: 'message', role: 'user', blocks } }
  })
}

function indexRecords(contents: string): Map<string, TranscriptRecord> {
  const byUuid = new Map<string, TranscriptRecord>()
  for (const line of contents.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue
    }
    const record = parsed as TranscriptRecord
    const uuid = stringField(record, 'uuid')
    if (uuid && !byUuid.has(uuid)) {
      byUuid.set(uuid, record)
    }
  }
  return byUuid
}

/** Records strictly after the anchor, oldest first. The branch proof already
 *  established that this walk reaches the anchor. */
function walkFromLeaf(
  byUuid: Map<string, TranscriptRecord>,
  leafUuid: string,
  anchorUuid: string
): TranscriptRecord[] {
  const collected: TranscriptRecord[] = []
  let cursor: string | null = leafUuid
  for (let depth = 0; cursor !== null && cursor !== anchorUuid; depth += 1) {
    if (depth >= MAX_HISTORY_WINDOW_WALK) {
      return []
    }
    const record = byUuid.get(cursor)
    if (!record) {
      return []
    }
    collected.push(record)
    cursor = stringField(record, 'parentUuid')
  }
  return collected.toReversed()
}

export function claudeProviderHistoryWindowFromJsonl(input: {
  contents: string
  providerSessionId: string
  previousLeafUuid: string | null
  /** Orca session id: the fingerprint a submission carries is scoped to it. */
  sessionId: string
  /** The caller must PROVE no provider child can be appending; absence proves
   *  nothing while a turn is running. */
  turnInFlight: boolean
}): ProviderHistoryWindow {
  if (!input.previousLeafUuid) {
    return INCONSISTENT
  }
  let leafUuid: string
  try {
    leafUuid = proveClaudeTranscriptBranchFromJsonl({
      contents: input.contents,
      providerSessionId: input.providerSessionId,
      previousLeafUuid: input.previousLeafUuid
    }).leafUuid
  } catch {
    // Every failure mode here — missing ancestor, sibling branch, compacted
    // cursor, torn tail — is a boundary we cannot vouch for.
    return INCONSISTENT
  }
  const byUuid = indexRecords(input.contents)
  const items: ProviderHistoryItem[] = []
  for (const record of walkFromLeaf(byUuid, leafUuid, input.previousLeafUuid)) {
    const blocks = claudePromptBlocks(record)
    const uuid = stringField(record, 'uuid')
    if (!blocks || !uuid) {
      continue
    }
    items.push({
      providerItemId: uuid,
      // Claude echoes no client message id, so identity matching reduces to the
      // fingerprint pass; the reconciler treats that as the weakest evidence.
      clientMessageId: null,
      payloadFingerprint: promptFingerprint(input.sessionId, blocks),
      identity: {
        provider: 'claude',
        sessionId: stringField(record, 'sessionId') ?? input.providerSessionId,
        uuid
      }
    })
  }
  return { items, boundaryConsistent: true, turnInFlight: input.turnInFlight }
}

/**
 * The window for one attached session: resolve the provider's transcript, then
 * read it against the handle's durable leaf. A live child means a send queued
 * behind its running turn is not in the file yet, so liveness is carried in
 * rather than assumed — only the adapter's session map can answer it.
 */
export async function resolveClaudeProviderHistoryWindow(input: {
  identity: AgentSessionJournalIdentity
  hasLiveSession: boolean
}): Promise<ProviderHistoryWindow | null> {
  const handle = input.identity.providerHandle
  if (handle.kind !== 'claude') {
    return null
  }
  const transcriptPath = await resolveSessionFilePath('claude', handle.sessionId)
  if (!transcriptPath) {
    return null
  }
  return readClaudeProviderHistoryWindow({
    transcriptPath,
    providerSessionId: handle.sessionId,
    previousLeafUuid: handle.leafUuid,
    sessionId: input.identity.sessionId,
    turnInFlight: input.hasLiveSession
  })
}

export async function readClaudeProviderHistoryWindow(input: {
  transcriptPath: string
  providerSessionId: string
  previousLeafUuid: string | null
  sessionId: string
  turnInFlight: boolean
}): Promise<ProviderHistoryWindow> {
  if (!input.previousLeafUuid) {
    return INCONSISTENT
  }
  let contents: string
  try {
    if ((await stat(input.transcriptPath)).size > MAX_HISTORY_WINDOW_SOURCE_BYTES) {
      return INCONSISTENT
    }
    contents = await readFile(input.transcriptPath, 'utf8')
  } catch {
    return INCONSISTENT
  }
  return claudeProviderHistoryWindowFromJsonl({ ...input, contents })
}
