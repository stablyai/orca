import { journalInputAttemptEnded } from './journal-input-obligations'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalQueueChange, JournalQueuedChange } from './journal-queue-events'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { JournalReducerState } from './journal-reducer'
import { unsentSendKeptAsCard } from './journal-unsent-send-hold'
import type { QueuedMessageRow } from './queued-message-table'

export type JournalRecoveryWork = {
  allowsRecovery: () => boolean
  owesSend: (submission: AgentJournalSubmission) => boolean
  generationEnded: (submission: AgentJournalSubmission) => boolean
  activeTurnId: () => string | null
  recoveryViewKey: () => string
}

/** A recovery copy exists only until a receipt or a person's queue action resolves it. */
export function unconfirmedRecoveryCards(
  state: JournalReducerState,
  cards: readonly QueuedMessageRow[],
  work: JournalRecoveryWork | null
): QueuedMessageRow[] {
  if (!work || !work.allowsRecovery()) {
    return []
  }
  const resolved = new Set(cards.flatMap((card) => card.recovers ?? []))
  const doubtful = [...state.inputs.candidates.values()].filter(
    (send) => !resolved.has(send.clientMessageId) && journalInputAttemptEnded(state, send, work)
  )
  doubtful.sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  const first = Math.min(0, ...cards.map((card) => card.position)) - doubtful.length
  const words = agentSessionFailureWords(agentSessionFailureFact('unconfirmed'), {
    surface: 'rejection'
  })
  return doubtful.flatMap((send, index) => {
    const body = unsentSendKeptAsCard(
      { ...send, queuedMessageId: undefined },
      state.inputs.sources.get(send.clientMessageId)?.body ?? null
    )
    return body
      ? [
          {
            messageId: `recovery:${send.clientMessageId}`,
            recovers: send.clientMessageId,
            position: first + index,
            body,
            fingerprint: agentSessionSendBodyFingerprint(state.sessionId, body),
            state: 'returned' as const,
            holdReason: null,
            returnedReason: words.reason,
            returnedRejection: words.rejection,
            consumedAs: null,
            queuedAt: { epoch: state.epoch, sequence: send.acceptedSequence ?? 0 },
            ...(send.options ? { options: send.options } : {})
          }
        ]
      : []
  })
}

export function adoptUnconfirmedRecovery(
  cards: readonly QueuedMessageRow[],
  messageId: string,
  change?: JournalQueueChange
): JournalQueuedChange | null {
  const card =
    change?.op === 'queued'
      ? undefined
      : cards.find((entry) => entry.messageId === messageId && entry.recovers)
  return card
    ? {
        ...queuedChangeOf(card),
        returned: {
          reason: card.returnedReason,
          ...(card.returnedRejection ? { rejection: card.returnedRejection } : {})
        }
      }
    : null
}
