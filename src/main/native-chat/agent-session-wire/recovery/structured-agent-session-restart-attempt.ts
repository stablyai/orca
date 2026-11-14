import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionResumeSelection } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import type { CommandReceiptDiscovery } from '../../agent-session-journal/writing/command-receipt-table'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  isRestartContinuationOf,
  restartContinuationBody,
  restartContinuationId,
  restartWitnessContinuationId
} from './structured-agent-session-restart-continuation-envelope'

export type RestartAttempt =
  | { kind: 'send'; id: string; body: AgentJournalMessageItem; predecessor?: string }
  | { kind: 'unknown' }

/** Ordinary send evidence owns attempts; the capsule only says which stopped task is offered. */
export function selectRestartAttempt(
  selection: AgentSessionResumeSelection,
  journal: AgentSessionJournal,
  discovered: CommandReceiptDiscovery | undefined,
  newBody: () => AgentJournalMessageItem = () => restartContinuationBody(selection.marker)
): RestartAttempt {
  const { marker } = selection
  if (!discovered || discovered.verdict === 'unreadable') {
    return { kind: 'unknown' }
  }
  const receipts = discovered.attempts
  if (receipts.some((read) => read.verdict === 'unreadable')) {
    return { kind: 'unknown' }
  }
  const attempts = new Map<
    string,
    { at: number; rejected: boolean; body?: AgentJournalMessageItem }
  >()
  for (const read of receipts) {
    if (read.verdict !== 'readable') {
      continue
    }
    const receipt = read.receipt
    const submission = journal.submission(receipt.operationId)
    const card = journal.queuedMessages.get(receipt.operationId)
    const body = journal.submissionBody(receipt.operationId) ?? card?.body ?? undefined
    attempts.set(receipt.operationId, {
      at: receipt.acceptedAt,
      rejected: receipt.status === 'rejected' || submission?.dispatchState === 'rejected',
      ...(body ? { body } : {})
    })
  }
  // Old builds may have accepted the message before command receipts existed.
  for (const submission of journal.inputOrder.acceptedInputsAfter(
    marker.journalCursor?.sequence ?? 0
  )) {
    const id = submission.clientMessageId
    if (isRestartContinuationOf(marker, id) && !attempts.has(id)) {
      const body = journal.submissionBody(id)
      attempts.set(id, {
        at: submission.submittedAt,
        rejected: submission.dispatchState === 'rejected',
        ...(body ? { body } : {})
      })
    }
  }
  for (const card of journal.queuedMessages.list()) {
    if (isRestartContinuationOf(marker, card.messageId) && !attempts.has(card.messageId)) {
      attempts.set(card.messageId, { at: 0, rejected: false, body: card.body })
    }
  }
  const live = [...attempts].filter(([, attempt]) => !attempt.rejected)
  if (live.length > 1) {
    return { kind: 'unknown' }
  }
  if (live.length === 1) {
    const [id, attempt] = live[0]
    return attempt.body ? { kind: 'send', id, body: attempt.body } : { kind: 'unknown' }
  }
  // Follow deterministic retry ancestry even when several rejections share a clock tick.
  const tips = [...attempts].filter(
    ([id]) => !attempts.has(restartWitnessContinuationId(marker, id))
  )
  tips.sort((a, b) => b[1].at - a[1].at)
  if (tips.length > 1 && tips[0][1].at === tips[1][1].at) {
    return { kind: 'unknown' }
  }
  const latest = tips[0]
  if (latest) {
    const [id, attempt] = latest
    // A retry selects one rejected predecessor; it cannot spend a later failure too.
    if (selection.failedAt === undefined || attempt.at > selection.failedAt) {
      return { kind: 'send', id, body: attempt.body ?? newBody() }
    }
    return {
      kind: 'send',
      id: restartWitnessContinuationId(marker, id),
      predecessor: id,
      body: newBody()
    }
  }
  if (selection.failure?.outcome === 'unconfirmed') {
    return { kind: 'unknown' }
  }
  if (selection.legacyAttempt) {
    return {
      kind: 'send',
      id: restartContinuationId(
        marker,
        selection.legacyAttempt.operationId,
        selection.legacyAttempt.startedAt
      ),
      body: newBody()
    }
  }
  return {
    kind: 'send',
    id: restartWitnessContinuationId(
      marker,
      selection.failedAt === undefined ? undefined : `failure:${selection.failedAt}`
    ),
    body: newBody()
  }
}
