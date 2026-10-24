// Provider history may narrow unknown delivery, never trigger automatic redelivery.
// User retries rotate IDs; unproven outcomes retain their original uncertainty.

import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionJournal } from './journal-store'
import { reconcileSubmissions, type ProviderHistoryWindow } from './journal-submission-reconciler'

/** Attachment paths are absent from provider history; only text-only sends can prove non-delivery. */
function comparableBody(body: AgentJournalMessageItem | undefined): boolean {
  return (
    body?.kind === 'message' &&
    body.role === 'user' &&
    // Conversation commands leave no provider user-message item to compare.
    body.command === undefined &&
    body.blocks.length === 1 &&
    body.blocks[0]?.type === 'text' &&
    body.blocks[0].text.trim().length > 0
  )
}

function comparableSubmissions(journal: AgentSessionJournal): AgentJournalSubmission[] {
  const snapshot = journal.snapshot()
  const { items, submissions } = agentSessionCurrentContextRows(
    snapshot.items,
    snapshot.submissions
  )
  const bodies = new Map(items.map((item) => [item.itemId, item.body]))
  return submissions.filter((submission) => {
    if (
      (submission.dispatchState !== 'pending' && submission.dispatchState !== 'unknown') ||
      isQueuedAgentJournalSubmission(submission) ||
      // Missing history cannot prove queued handoffs unsent.
      submission.queuedMessageId !== undefined ||
      // Carried stopped-history prefixes change fingerprints; absence cannot prove non-delivery.
      journal.stoppedHistoryCarried().has(submission.clientMessageId)
    ) {
      return false
    }
    const body = bodies.get(agentJournalSubmissionKey(submission.clientMessageId))
    return comparableBody(body?.kind === 'message' ? body : undefined)
  })
}

/** Exclude committed history so uncertain sends cannot match earlier identical messages. */
function unseenHistory(
  journal: AgentSessionJournal,
  history: ProviderHistoryWindow
): ProviderHistoryWindow {
  const snapshot = journal.snapshot()
  const committed = new Set(snapshot.items.map((item) => item.itemId))
  // Accepted echoes render under Orca IDs; also exclude their aliased provider identities.
  for (const submission of snapshot.submissions) {
    if (submission.dispatchState === 'accepted' && submission.providerItemId) {
      committed.add(submission.providerItemId)
    }
  }
  return {
    ...history,
    // Identity-free items rely on the adapter's after-last-acceptance history window.
    items: history.items.filter(
      (item) => item.identity === undefined || !committed.has(agentJournalItemKey(item.identity))
    )
  }
}

export async function reconcileJournalSubmissionsAgainstHistory(input: {
  journal: AgentSessionJournal
  fence: number
  history: ProviderHistoryWindow
}): Promise<string[]> {
  const submissions = comparableSubmissions(input.journal)
  if (submissions.length === 0) {
    return []
  }
  const settled: string[] = []
  for (const outcome of reconcileSubmissions({
    submissions,
    history: unseenHistory(input.journal, input.history)
  })) {
    if (outcome.outcome === 'unknown') {
      console.warn('[journal-reconcile] submission left unconfirmed:', {
        clientMessageId: outcome.clientMessageId,
        reason: outcome.reason,
        fence: input.fence
      })
      continue
    }
    await input.journal.resolveDispatch(
      outcome.outcome === 'accepted'
        ? {
            clientMessageId: outcome.clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.identity,
            fence: input.fence,
            recovered: true
          }
        : {
            clientMessageId: outcome.clientMessageId,
            state: 'rejected',
            ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), {
              surface: 'rejection'
            }),
            fence: input.fence,
            recovered: true
          }
    )
    settled.push(outcome.clientMessageId)
  }
  return settled
}
