import type { AgentSessionAttentionEdge } from '../../../shared/agent-session-attention'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

/** Missing causal evidence keeps the host's ordinary phone delivery. */
export function structuredPhoneAlertCaller(
  sessions: Pick<ReadonlyMap<string, { journal: AgentSessionJournal }>, 'get'>,
  readStore: () => AgentSessionRecordStore,
  edge: AgentSessionAttentionEdge
): string | null {
  try {
    const id = edge.type === 'prompt' ? edge.prompt.sessionId : edge.completion.sessionId
    const journal = sessions.get(id)?.journal
    if (!journal) {
      return null
    }
    const payload = edge.type === 'prompt' ? edge.prompt : edge.completion
    const snapshot = journal.snapshot()
    if (payload.journalCursor?.epoch !== snapshot.cursor.epoch) {
      return null
    }
    const item =
      edge.type === 'prompt'
        ? journal.item(edge.prompt.promptId)
        : snapshot.items.find(
            (candidate) =>
              isRootAgentJournalItem(candidate) &&
              readAgentJournalTurn(candidate.body)?.turnId === edge.completion.turnId
          )
    const root = item?.turnScope?.kind === 'turn' ? journal.item(item.turnScope.turnItemId) : item
    const turn = root && isRootAgentJournalItem(root) ? readAgentJournalTurn(root.body) : null
    const key =
      turn?.userItemId ?? (edge.type === 'completion' ? edge.completion.turnId : undefined)
    const identity = key ? parseAgentJournalItemKey(key) : null
    if (identity?.provider !== 'orca') {
      return null
    }
    const submission = snapshot.submissions.find(
      (entry) => entry.clientMessageId === identity.clientMessageId
    )
    if (!submission) {
      return null
    }
    const direct = readStore().readCommandReceiptCandidates(
      { kind: 'global' },
      submission.clientMessageId
    )
    if (direct.verdict !== 'readable') {
      return null
    }
    const accepted = direct.receipts.filter(
      (receipt) =>
        receipt.status === 'accepted' &&
        receipt.sessionId === payload.sessionId &&
        (receipt.method === 'agentSession.send' ||
          receipt.method === 'agentSession.queuedMessageSend') &&
        receipt.result.kind === 'journal-row' &&
        receipt.result.epoch === snapshot.cursor.epoch &&
        receipt.result.sequence === submission.submittedSequence
    )
    if (accepted.length === 1) {
      return accepted[0]!.callerKey
    }
    if (!submission.queuedMessageId) {
      return null
    }
    const queued =
      submission.clientMessageId === submission.queuedMessageId
        ? direct
        : direct.receipts.length === 0
          ? readStore().readCommandReceiptCandidates({ kind: 'global' }, submission.queuedMessageId)
          : null
    if (queued?.verdict !== 'readable') {
      return null
    }
    const originals = queued.receipts.filter(
      (receipt) =>
        receipt.status === 'accepted' &&
        receipt.sessionId === payload.sessionId &&
        receipt.method === 'agentSession.send' &&
        receipt.result.kind === 'queued-draft' &&
        receipt.result.messageId === submission.queuedMessageId
    )
    return originals.length === 1 ? originals[0]!.callerKey : null
  } catch {
    return null
  }
}
