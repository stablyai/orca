// Render models for the host-held queued drafts shown above the composer.
// The wire carries no hold copy on purpose: the caption is derived here from the
// draft's own state plus the live facts the client already holds.

import { readAgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionAttemptFailureParts } from '../../../src/shared/structured-agent-session-send-disposition'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuePause
} from '../../../src/shared/agent-session-wire'

export type MobileQueuedMessageCard = {
  messageId: string
  /** The draft's text blocks joined for display and for Edit's composer copy. */
  text: string
  state: 'waiting' | 'returned'
  paused: boolean
  /** Returned, or its own send failed: the row leads with an alert. */
  needsAttention: boolean
  /** Status under the text; null for a card plainly waiting its turn, the paused queue's too. */
  caption: string | null
}

function queuedMessageBodyText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function returnedCaption(
  draft: Pick<AgentSessionQueuedMessage, 'returnedReason' | 'returnedRejection'>
): string {
  const reason = draft.returnedReason ?? null
  const rejection = draft.returnedRejection
  if (dispatchWasWithdrawn({ dispatchState: 'rejected', reason, rejection })) {
    return 'Stopped before it was sent'
  }
  // Worded as the desktop card words it: the fact decides, the reason is the fallback, and the
  // card's own Send is the retry, so the words leave out sending again.
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionAttemptFailureParts(
      { kind: 'rejected', reason },
      { retryControl: true },
      readAgentSessionFailureFact(rejection)
    )
  )
}

/** One card's own hold: only a failed conversion; the queue's pause is the list's first row. */
function pausedCaption(reason: string | undefined): string {
  if (reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
    return "Couldn't send — tap Send to retry"
  }
  // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
  return 'Paused'
}

const QUEUE_PAUSE_LABELS: Readonly<Record<string, string>> = {
  stopped: 'Queue paused because you interrupted',
  restarted: 'Queue paused because Orca restarted',
  cleared: 'Queue paused after you cleared the conversation'
}

/** Whether Resume would send anything: a waiting card with no hold of its own, ahead of any
 *  returned card. The drain stops at a returned card, so cards behind one never go. */
export function mobileQueueHasResumableCard(cards: readonly MobileQueuedMessageCard[]): boolean {
  for (const card of cards) {
    if (card.state === 'returned') {
      return false
    }
    if (!card.paused) {
      return true
    }
  }
  return false
}

/** The paused queue's first row. A reason this build does not know (a newer host's) reads as a
 *  plain pause. */
export function mobileQueuePauseLabel(pause: Pick<AgentSessionQueuePause, 'reason'>): string {
  return QUEUE_PAUSE_LABELS[pause.reason] ?? 'Queue paused'
}

/** Cards in published order. A waiting card is hidden once a live hand-off of it arrived — a
 *  submission naming it as its `queuedMessageId` that was not rejected — as the desktop hides it:
 *  on a multi-page catch-up the shrunk list rides only the final page, so the bubble and the card
 *  would otherwise briefly show together. A rejected hand-off is what sent the draft back, so it
 *  hides nothing. Returned cards always show. */
export function mobileQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null,
  submissions: readonly Pick<AgentJournalSubmission, 'queuedMessageId' | 'dispatchState'>[],
  facts: { pendingPrompt: boolean; queuePaused?: boolean }
): MobileQueuedMessageCard[] {
  if (!queuedMessages || queuedMessages.length === 0) {
    return []
  }
  const handedOff = new Set(
    submissions.flatMap((submission) =>
      submission.queuedMessageId !== undefined && submission.dispatchState !== 'rejected'
        ? [submission.queuedMessageId]
        : []
    )
  )
  let behindReturned = false
  const cards: MobileQueuedMessageCard[] = []
  for (const draft of queuedMessages) {
    if (draft.state !== 'returned' && handedOff.has(draft.messageId)) {
      continue
    }
    const paused = draft.paused === true
    const caption =
      draft.state === 'returned'
        ? returnedCaption(draft)
        : paused
          ? pausedCaption(draft.pausedReason)
          : behindReturned
            ? 'Waiting — a message ahead needs attention'
            : facts.queuePaused
              ? // The pause row says why and offers Resume; the card promises no send time.
                null
              : facts.pendingPrompt
                ? 'Waiting for your answer'
                : null
    cards.push({
      messageId: draft.messageId,
      text: queuedMessageBodyText(draft.body),
      state: draft.state,
      paused,
      needsAttention:
        draft.state === 'returned' ||
        (paused && draft.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED),
      caption
    })
    if (draft.state === 'returned') {
      behindReturned = true
    }
  }
  return cards
}
