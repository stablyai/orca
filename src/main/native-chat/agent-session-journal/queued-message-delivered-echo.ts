// A draft sent back to waiting rests on its submission's "never delivered"
// claim. The provider echoing that message proves the claim wrong: the first
// delivery happened. The reducer keeps such an echo apart (a rejected
// submission may not claim it), so it is read here, from the row itself.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  isProviderUserMessageEcho,
  journalEchoClaimant,
  type JournalReducerState
} from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'

/** The waiting draft this appended row proves was delivered, or null. Called
 *  before the row applies, for every row, so a row that is no new provider
 *  echo of a user message returns before anything else is read. */
export function draftDeliveredByEcho(
  state: JournalReducerState,
  drafts: () => readonly QueuedMessageRow[],
  row: JournalRow
): string | null {
  const echoes = appendedItems(row).filter(
    (item) =>
      isProviderUserMessageEcho(item.itemId, item.body) &&
      !state.items.has(item.itemId) &&
      !state.aliases.has(item.itemId) &&
      journalEchoClaimant(state, item.itemId, item.body) === null
  )
  if (echoes.length === 0) {
    return null
  }
  const spent = spentWaitingDrafts(state, drafts())
  for (const item of echoes) {
    const delivered = spent.find((draft) => echoProvesDelivered(state, draft, item.body, row.seq))
    if (delivered) {
      return delivered.draft.messageId
    }
  }
  return null
}

/**
 * The re-derivation behind that per-row hook, which is bookkeeping and may be
 * skipped: waiting drafts an echo ALREADY in the journal proves delivered. An
 * unclaimed echo is the item still stored under its provider id — a claimed one
 * was folded into its submission's item. Reads every item, so callers run it
 * only where a draft is about to send, never per streamed row.
 */
export function draftsDeliveredByAppliedEcho(
  state: JournalReducerState,
  drafts: readonly QueuedMessageRow[]
): string[] {
  const spent = spentWaitingDrafts(state, drafts)
  if (spent.length === 0) {
    return []
  }
  const delivered = new Set<string>()
  for (const item of state.items.values()) {
    if (!isProviderUserMessageEcho(item.itemId, item.body)) {
      continue
    }
    for (const candidate of spent) {
      if (echoProvesDelivered(state, candidate, item.body, item.sequence)) {
        delivered.add(candidate.draft.messageId)
      }
    }
  }
  return [...delivered]
}

type SpentDraft = { draft: QueuedMessageRow; since: number }

/** Waiting drafts some hand-off of which was handed over, then rejected as never delivered;
 *  `since` is the earliest such hand-off's row. A hand-off rejected before hand-over is
 *  provably unwritten: an echo matching it is some other message, and must not delete the card. */
function spentWaitingDrafts(
  state: JournalReducerState,
  drafts: readonly QueuedMessageRow[]
): SpentDraft[] {
  const since = new Map<string, number>()
  for (const submission of state.submissions.values()) {
    if (
      submission.queuedMessageId !== undefined &&
      submission.dispatchState === 'rejected' &&
      submission.handedOverAt !== undefined
    ) {
      const sequence = submission.acceptedSequence ?? 0
      const earliest = since.get(submission.queuedMessageId)
      since.set(submission.queuedMessageId, Math.min(earliest ?? sequence, sequence))
    }
  }
  return drafts.flatMap((draft) => {
    const from = since.get(draft.messageId)
    return draft.state === 'waiting' && from !== undefined ? [{ draft, since: from }] : []
  })
}

/** The one predicate both paths share: an unclaimed echo appended after a disproved hand-off,
 *  carrying the draft's own payload. */
function echoProvesDelivered(
  state: JournalReducerState,
  spent: SpentDraft,
  body: AgentJournalItemBody,
  sequence: number
): boolean {
  return (
    sequence > spent.since &&
    agentSessionSendBodyFingerprint(state.sessionId, body) === spent.draft.fingerprint
  )
}

function appendedItems(row: JournalRow): { itemId: string; body: AgentJournalItemBody }[] {
  if (row.kind === 'item') {
    return [{ itemId: row.itemId, body: row.body }]
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.flatMap((mutation) =>
      mutation.kind === 'item' ? [{ itemId: mutation.itemId, body: mutation.body }] : []
    )
  }
  return []
}
