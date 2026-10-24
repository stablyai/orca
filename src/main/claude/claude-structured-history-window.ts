// Reconcile sends against the transcript Claude resumes, from the durable anchor to the file tail.
// Unproven ancestry makes absence inconclusive, so report an inconsistent boundary, not an empty window.

import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  CLAUDE_STRUCTURED_HANDLE_NAMESPACE,
  claudeProviderHandleLeafUuid,
  isAgentSessionProviderHandleInNamespace
} from '../../shared/agent-session-provider-handle-encoding'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type {
  ProviderHistoryItem,
  ProviderHistoryWindow
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { claudeContentBlocks } from '../native-chat/transcript-record-blocks'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  replayClaudeTranscriptBranchAncestry,
  replayClaudeTranscriptBranchAncestryFromJsonl
} from './claude-transcript-branch-proof'

// Bound each JSONL record without imposing a whole-file limit.
const MAX_HISTORY_WINDOW_RECORD_BYTES = 16 * 1024 * 1024

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

/** Recover the text bytes Claude received; the shared decoder trims for display. */
function rawTextParts(content: unknown): string[] | null {
  if (typeof content === 'string') {
    return content.trim() ? [content] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) {
        parts.push(part)
      }
      continue
    }
    const record = part && typeof part === 'object' ? (part as TranscriptRecord) : null
    if (!record || record.type !== 'text' || typeof record.text !== 'string') {
      return null
    }
    if (record.text.trim()) {
      parts.push(record.text)
    }
  }
  return parts
}

/** Exclude injected turns and attachments: transcript images lack the paths needed for send fingerprints. */
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
  // Inspect raw content because the display decoder omits images, which would change fingerprints.
  if (Array.isArray(content) && !content.every((part) => isPlainTextPart(part))) {
    return null
  }
  const blocks = claudeContentBlocks(content)
  if (blocks.length === 0 || blocks.some((block) => block.type !== 'text')) {
    return null
  }
  const rawTexts = rawTextParts(content)
  if (rawTexts === null || rawTexts.length !== blocks.length) {
    return null
  }
  const preservedBlocks = blocks.map((block, index) => ({
    ...block,
    text: rawTexts[index]!
  }))
  const [first] = preservedBlocks
  if (first?.type !== 'text' || isKnownHarnessInjectedUserTurnText(first.text)) {
    return null
  }
  return preservedBlocks
}

/** Use the same canonical fingerprint enforced at send admission. */
function promptFingerprint(sessionId: string, blocks: NativeChatBlock[]): string {
  return computeAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body: { kind: 'message', role: 'user', blocks } }
  })
}

type HistoryWindowInput = {
  providerSessionId: string
  previousLeafUuid: string | null
  /** Send fingerprints are scoped to the Orca session. */
  sessionId: string
  /** Absence is conclusive only when the caller proves no provider child can still append. */
  turnInFlight: boolean
}

/** Retain fingerprints, not prompt bodies, while replaying the proven branch. */
function createWindowCollector(input: HistoryWindowInput) {
  const byUuid = new Map<string, ProviderHistoryItem>()
  return { byUuid, onAncestorRecord }

  function onAncestorRecord(record: TranscriptRecord, uuid: string): void {
    const blocks = claudePromptBlocks(record)
    if (!blocks) {
      return
    }
    byUuid.set(uuid, {
      providerItemId: uuid,
      // Claude omits client message IDs; reconciliation must use weaker fingerprint evidence.
      clientMessageId: null,
      payloadFingerprint: promptFingerprint(input.sessionId, blocks),
      identity: {
        provider: 'claude',
        sessionId: stringField(record, 'sessionId') ?? input.providerSessionId,
        uuid
      }
    })
  }
}

function windowFromChain(
  chain: readonly string[],
  byUuid: Map<string, ProviderHistoryItem>,
  turnInFlight: boolean
): ProviderHistoryWindow {
  const items: ProviderHistoryItem[] = []
  for (const uuid of chain.toReversed()) {
    const item = byUuid.get(uuid)
    if (item) {
      items.push(item)
    }
  }
  return { items, boundaryConsistent: true, turnInFlight }
}

export function claudeProviderHistoryWindowFromJsonl(
  input: HistoryWindowInput & { contents: string }
): ProviderHistoryWindow {
  const ancestryAnchorUuid = input.previousLeafUuid
  if (!ancestryAnchorUuid) {
    return INCONSISTENT
  }
  const collector = createWindowCollector(input)
  try {
    const { chain } = replayClaudeTranscriptBranchAncestryFromJsonl({
      contents: input.contents,
      providerSessionId: input.providerSessionId,
      previousLeafUuid: ancestryAnchorUuid,
      ancestryAnchorUuid,
      onAncestorRecord: collector.onAncestorRecord
    })
    return windowFromChain(chain, collector.byUuid, input.turnInFlight)
  } catch {
    // Unproven ancestry cannot establish that a send is absent.
    return INCONSISTENT
  }
}

/** A live child can still append queued sends, so transcript absence cannot prove non-delivery. */
export async function resolveClaudeProviderHistoryWindow(input: {
  identity: AgentSessionJournalIdentity
  accountHomePath: string
  hasLiveSession: boolean
}): Promise<ProviderHistoryWindow | null> {
  const handle = input.identity.providerHandle
  if (
    !handle ||
    !isAgentSessionProviderHandleInNamespace(handle, CLAUDE_STRUCTURED_HANDLE_NAMESPACE)
  ) {
    return null
  }
  const transcriptPath = await resolveSessionFilePath('claude', handle.nativeId, {
    claudeProjectsDir: join(input.accountHomePath, 'projects')
  })
  if (!transcriptPath) {
    return null
  }
  return readClaudeProviderHistoryWindow({
    transcriptPath,
    providerSessionId: handle.nativeId,
    previousLeafUuid: claudeProviderHandleLeafUuid(handle),
    sessionId: input.identity.sessionId,
    turnInFlight: input.hasLiveSession
  })
}

export async function readClaudeProviderHistoryWindow(
  input: HistoryWindowInput & { transcriptPath: string }
): Promise<ProviderHistoryWindow> {
  const ancestryAnchorUuid = input.previousLeafUuid
  if (!ancestryAnchorUuid) {
    return INCONSISTENT
  }
  const collector = createWindowCollector(input)
  try {
    const { chain } = await replayClaudeTranscriptBranchAncestry({
      transcriptPath: input.transcriptPath,
      providerSessionId: input.providerSessionId,
      previousLeafUuid: ancestryAnchorUuid,
      ancestryAnchorUuid,
      maxRecordBytes: MAX_HISTORY_WINDOW_RECORD_BYTES,
      onAncestorRecord: collector.onAncestorRecord
    })
    return windowFromChain(chain, collector.byUuid, input.turnInFlight)
  } catch (error) {
    // Read, ancestry, and record-size failures leave absence inconclusive.
    console.warn('[claude-history-window] transcript unprovable; boundary inconsistent:', {
      transcriptPath: input.transcriptPath,
      sessionId: input.sessionId,
      error
    })
    return INCONSISTENT
  }
}
