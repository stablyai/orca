// Derive queue captions from draft/live facts because the host sends no hold copy.

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
  type AgentSessionQueuedMessage
} from '../../../src/shared/agent-session-wire'
import { readAgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import { agentMessageAttribution } from './mobile-agent-message-attribution'

export type MobileQueuedMessageCard = {
  messageId: string
  automatic?: true
  text: string
  state: 'waiting' | 'returned'
  paused: boolean
  needsAttention: boolean
  // Leave plain waits uncaptioned; the question or queue-pause row already explains the hold.
  caption: string | null
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
  // Reuse desktop failure wording but omit retry instructions: this card’s Send is the retry.
  return agentSessionWriteNoticeEnglish(
    structuredAgentSessionAttemptFailureParts(
      { kind: 'rejected', reason },
      { agentName, retryControl: true },
      readWholeAgentSessionFailureFact(rejection)
    )
  )
}

/** One card's own hold: a failed conversion; the queue's pause is the list's header. */
function pausedCaption(reason: string | undefined, waitsForAgent: boolean): string {
  if (reason === QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
    return waitsForAgent
      ? "Couldn't send — tap Send to retry once the agent finishes"
      : "Couldn't send — tap Send to retry"
  }
  // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
  return 'Paused'
}

// Returned cards stop the drain, so waiting cards behind one cannot make Resume useful.
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

// Hide waiting cards with non-rejected hand-offs until catch-up publishes the final queue; rejected hand-offs and returned cards must remain reachable.
export function mobileQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null,
  submissions: readonly Pick<AgentJournalSubmission, 'queuedMessageId' | 'dispatchState'>[],
  facts: {
    agentWorking?: boolean
    agentName?: string
    statedFailures?: readonly AgentSessionFailureFact[]
  } = {}
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
            : null
    cards.push({
      messageId: draft.messageId,
      ...(draft.body.from !== undefined ? { automatic: true as const } : {}),
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
