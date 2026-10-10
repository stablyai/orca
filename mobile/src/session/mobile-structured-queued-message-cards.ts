// Render models for the host-held queued drafts shown above the composer.
// The wire carries no hold copy on purpose: the caption is derived here from the
// draft's own state plus the live facts the client already holds.

import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../src/shared/agent-session-failure'
import { agentSessionFailureStatedByRow } from '../../../src/shared/agent-session-visible-failures'
import {
  agentSessionWriteNotDoneParts,
  agentSessionWriteNoticeEnglish
} from '../../../src/shared/agent-session-refusal-notice'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionAttemptFailureParts } from '../../../src/shared/structured-agent-session-rejection-words'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuePause
} from '../../../src/shared/agent-session-wire'
import { readAgentMessageSource } from '../../../src/shared/agent-session-message-source'
import { agentMessageAttribution } from './mobile-agent-message-attribution'

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
  /** "From <name>" on another agent's card; null on the person's. */
  attribution: string | null
  /** A conversation command such as /compact: it never steers into a running turn. */
  command?: true
  /** A command card while the agent works: it offers no send until the agent is idle. */
  waitsForAgent?: true
}

function queuedMessageBodyText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function returnedCaption(
  draft: Pick<AgentSessionQueuedMessage, 'returnedReason' | 'returnedRejection'>,
  agentName?: string,
  statedFailures: readonly AgentSessionFailureFact[] = []
): string {
  const reason = draft.returnedReason ?? null
  const rejection = draft.returnedRejection
  if (agentSessionFailureStatedByRow(rejection, statedFailures)) {
    return agentSessionWriteNoticeEnglish(agentSessionWriteNotDoneParts('send'))
  }
  if (dispatchWasWithdrawn({ dispatchState: 'rejected', reason, rejection })) {
    return 'Stopped before it was sent'
  }
  // Worded as the desktop card words it: a fact read whole decides, the host's reason is the
  // fallback, and the card's own Send is the retry, so the words leave out sending again.
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionAttemptFailureParts(
      { kind: 'rejected', reason },
      { agentName, retryControl: true },
      readWholeAgentSessionFailureFact(rejection)
    )
  )
}

/** One card's own hold: a failed conversion; the queue's pause is the list's first row. */
function pausedCaption(reason: string | undefined, waitsForAgent: boolean): string {
  if (reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
    return waitsForAgent
      ? "Couldn't send — tap Send to retry once the agent finishes"
      : "Couldn't send — tap Send to retry"
  }
  // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
  return 'Paused'
}

const QUEUE_PAUSE_LABELS: Readonly<Record<string, string>> = {
  stopped: 'Queue paused because you interrupted'
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
  facts: {
    pendingPrompt: boolean
    queuePaused?: boolean
    agentWorking?: boolean
    agentName?: string
    statedFailures?: readonly AgentSessionFailureFact[]
  }
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
        ? returnedCaption(draft, facts.agentName, facts.statedFailures)
        : paused
          ? pausedCaption(
              draft.pausedReason,
              draft.body.command !== undefined && facts.agentWorking === true
            )
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
      caption,
      attribution: agentMessageAttribution('From', readAgentMessageSource(draft.body.from)),
      ...(draft.body.command !== undefined
        ? {
            command: true as const,
            ...(facts.agentWorking ? { waitsForAgent: true as const } : {})
          }
        : {})
    })
    if (draft.state === 'returned') {
      behindReturned = true
    }
  }
  return cards
}
