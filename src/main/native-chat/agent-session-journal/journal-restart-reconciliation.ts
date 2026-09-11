// The production caller for `reconcileSubmissions`.
//
// Runs once per journal open, after the crash boundary has already settled every
// survivor to `unknown`. It only ever narrows that answer: `accepted` when the
// provider's own history holds the message, `rejected` when a boundary we can
// vouch for proves it never arrived. Anything the reconciler leaves `unknown`
// is left exactly as the crash boundary wrote it.
//
// Nothing here dispatches. A `rejected` submission becomes re-sendable only
// through the user's Retry, which rotates the client message id; Orca still
// never puts a message back on the wire on the user's behalf.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from './journal-store'
import { reconcileSubmissions, type ProviderHistoryWindow } from './journal-submission-reconciler'

/**
 * Only a text-only body can be compared against provider content. A submission
 * carrying an attachment was fingerprinted over an `image-ref` path the
 * transcript does not keep, so its absence from history would be an artefact of
 * the encoding rather than evidence — and `rejected` is the one outcome that
 * costs the user a duplicate if it is wrong. Those stay `unknown`.
 */
function comparableBody(body: AgentJournalMessageItem | undefined): boolean {
  return (
    body?.kind === 'message' &&
    body.role === 'user' &&
    body.blocks.length > 0 &&
    body.blocks.every((block) => block.type === 'text')
  )
}

function comparableSubmissions(journal: AgentSessionJournal): AgentJournalSubmission[] {
  const { items, submissions } = journal.snapshot()
  const bodies = new Map(items.map((item) => [item.itemId, item.body]))
  return submissions.filter((submission) => {
    if (submission.dispatchState !== 'pending' && submission.dispatchState !== 'unknown') {
      return false
    }
    const body = bodies.get(agentJournalSubmissionKey(submission.clientMessageId))
    return comparableBody(body?.kind === 'message' ? body : undefined)
  })
}

/** Items the journal already committed are not new evidence: leaving them
 *  claimable would let an undelivered message match an older identical one. */
function unseenHistory(
  journal: AgentSessionJournal,
  history: ProviderHistoryWindow
): ProviderHistoryWindow {
  const committed = new Set(journal.snapshot().items.map((item) => item.itemId))
  return {
    ...history,
    items: history.items.filter((item) => !committed.has(agentJournalItemKey(item.identity)))
  }
}

/**
 * Decide what the crash boundary could only doubt. Returns the client message
 * ids this pass settled, so the attach result stops reporting them unconfirmed.
 */
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
            reason: outcome.reason,
            fence: input.fence,
            recovered: true
          }
    )
    settled.push(outcome.clientMessageId)
  }
  return settled
}
