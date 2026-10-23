import { usableJournalHistoryOrigin } from '../native-chat/agent-session-journal/journal-history-origin'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentJournalPosition } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemPosition,
  compareAgentJournalPositions
} from '../../shared/agent-session-journal-position'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../shared/agent-session-journal-producer'
import type { StructuredAgentSessionHistoryJournal } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

const TURN_LIFECYCLE_RECORD_PREFIX = 'turn-lifecycle:'

export type CodexHistoryJournalView = {
  epoch: string
  nativePromptKeys: ReadonlySet<string>
  /** Provider turns represented by saved rows or native receipts. */
  known: ReadonlySet<string>
  /** Latest represented turn by journal position, including within a batch. */
  latest: string | null
  latestPosition: AgentJournalPosition | null
  hasRows: boolean
  /** Proven transcript origin, independent of subsequently imported provider identities. */
  importedAt: number | null
  unresolvedOrigin: boolean
}

export function readCodexHistoryJournalView(
  journal: StructuredAgentSessionHistoryJournal,
  threadId: string
): CodexHistoryJournalView {
  const known = new Set<string>()
  const nativePromptKeys = new Set<string>()
  let latest: string | null = null
  let latestPosition: AgentJournalPosition | null = null
  let hasRows = false
  let hasLegacy = false
  const note = (turnId: string, position: AgentJournalPosition): void => {
    known.add(turnId)
    if (latestPosition === null || compareAgentJournalPositions(position, latestPosition) > 0) {
      latest = turnId
      latestPosition = position
    }
  }
  journal.visitItemsWithLinkage((itemId, sequence, body, attribution) => {
    hasRows = true
    if (!isRootAgentJournalItem(attribution)) {
      return
    }
    const identity = parseAgentJournalItemKey(itemId)
    if (
      identity?.provider === 'legacy' &&
      identity.agent === 'codex' &&
      identity.sessionId === threadId &&
      (body.kind === 'message' || body.kind === 'tool-call')
    ) {
      hasLegacy = true
    }
    if (identity?.provider === 'orca' && body.kind === 'message' && body.role === 'user') {
      nativePromptKeys.add(itemId)
    }
    const turnId = codexTurnIdOfRow(itemId, body, threadId)
    if (turnId) {
      note(turnId, agentJournalItemPosition(journal.item(itemId) ?? { sequence }))
    }
  })
  // A send accepted before its turn row landed still names its turn through its provider item.
  for (const submission of journal.submissions()) {
    const promptKey = agentJournalSubmissionKey(submission.clientMessageId)
    nativePromptKeys.add(promptKey)
    const identity = submission.providerItemId
      ? parseAgentJournalItemKey(submission.providerItemId)
      : null
    if (identity?.provider === 'codex' && identity.threadId === threadId) {
      known.add(identity.turnId)
      const prompt = journal.item(promptKey)
      const receipt = journal.receiptFor(submission.clientMessageId)
      if (prompt) {
        note(identity.turnId, agentJournalItemPosition(prompt))
      } else if (
        receipt?.cursor.epoch === journal.epoch &&
        Number.isSafeInteger(receipt.cursor.sequence) &&
        receipt.cursor.sequence > 0
      ) {
        note(identity.turnId, { sequence: receipt.cursor.sequence, index: 0 })
      }
    }
  }
  const rawOrigin = journal.historyOrigin()
  const origin = usableJournalHistoryOrigin(rawOrigin)
  const importedAt =
    origin?.providerHandle.kind === 'codex' && origin.providerHandle.threadId === threadId
      ? origin.importedAt
      : null
  return {
    epoch: journal.epoch,
    nativePromptKeys,
    known,
    latest,
    latestPosition,
    hasRows,
    importedAt,
    unresolvedOrigin: (hasLegacy || rawOrigin !== null) && importedAt === null
  }
}

function codexTurnIdOfRow(
  itemId: string,
  body: Parameters<typeof readAgentJournalTurn>[0],
  threadId: string
): string | null {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider === 'codex') {
    return identity.threadId === threadId ? identity.turnId : null
  }
  const turn = readAgentJournalTurn(body)
  if (!turn) {
    return null
  }
  // A command's turn row carries Orca's own turn id; the provider turn rides beside it.
  if (body?.kind === 'turn' && body.providerTurnId) {
    return body.providerTurnId
  }
  return identity?.provider === 'legacy' &&
    identity.agent === 'codex' &&
    identity.recordId.startsWith(TURN_LIFECYCLE_RECORD_PREFIX)
    ? turn.turnId
    : null
}

/** Planning and commit use the same authoritative saved facts. */
export function sameCodexHistoryJournalView(
  a: CodexHistoryJournalView,
  b: CodexHistoryJournalView
): boolean {
  return (
    a.epoch === b.epoch &&
    a.unresolvedOrigin === b.unresolvedOrigin &&
    a.importedAt === b.importedAt &&
    a.hasRows === b.hasRows &&
    a.latest === b.latest &&
    JSON.stringify(a.latestPosition) === JSON.stringify(b.latestPosition) &&
    a.known.size === b.known.size &&
    [...a.known].every((id) => b.known.has(id)) &&
    a.nativePromptKeys.size === b.nativePromptKeys.size &&
    [...a.nativePromptKeys].every((key) => b.nativePromptKeys.has(key))
  )
}
