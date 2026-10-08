// Which unanswered sends a person's Stop takes back as never sent, when Codex takes it or the child
// ends, read from the journal at the settlement that lands, so a retried settle reads the same rows.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentType } from '../../../shared/agent-status-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** What the derivation reads; absent members (a narrow double) withdraw nothing. */
export type UnopenedSendJournal = {
  agent?: AgentType
  queuedMessages?: Pick<AgentSessionJournal['queuedMessages'], 'userStopInForce'>
  snapshot: () => Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  submissions?: () => Pick<
    AgentJournalSubmission,
    | 'clientMessageId'
    | 'dispatchState'
    | 'recovered'
    | 'handoverRecorded'
    | 'handedOverAt'
    | 'acceptedSequence'
  >[]
  resolveDispatch?: AgentSessionJournal['resolveDispatch']
}

/** A send a dying child can take back: one still being handed over, or one this process left in
 *  doubt (its answer was lost). Never a queued card's, nor a send an earlier process left behind. */
export function sendStopCanTakeBack(
  entry: Pick<
    AgentJournalSubmission,
    'dispatchState' | 'recovered' | 'handoverRecorded' | 'handedOverAt'
  >
): boolean {
  return (
    !isQueuedAgentJournalSubmission(entry) &&
    (entry.dispatchState === 'pending' ||
      (entry.dispatchState === 'unknown' && entry.recovered !== true))
  )
}

/**
 * Withdraws the sends a Codex child left unanswered when a person's Stop, in force since they were
 * sent, ends the child or is taken by Codex: each one that started its own turn (handed over with no turn running, so its
 * message belongs to no turn) when no turn has opened since. Codex records a prompt only once its
 * turn starts (core tasks/regular.rs:50, session/turn.rs:886-902), so they never ran. A send that
 * joined a running turn may be in it, so it, a send with no recorded place, and any other end stay
 * in doubt.
 */
export async function withdrawCodexSendsNoTurnOpenedFor(
  journal: UnopenedSendJournal,
  fence: number
): Promise<void> {
  const stop = journal.agent === 'codex' ? journal.queuedMessages?.userStopInForce() : null
  if (!stop || !journal.submissions || !journal.resolveDispatch) {
    return
  }
  const { items } = journal.snapshot()
  const turns = items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn ? [{ running: turn.state === 'running', sequence: item.sequence }] : []
  })
  // Its message's place, recorded at handover: the turn it joined, or the conversation. A send
  // that started its own turn has the conversation's; one with no turn recorded since then never ran.
  const ownTurnHandover = (clientMessageId: string): number | undefined => {
    const handover = items.find(
      (item) => item.itemId === agentJournalSubmissionKey(clientMessageId)
    )
    return handover?.turnScope?.kind === 'thread' ? handover.sequence : undefined
  }
  const openedSince = (handoverSequence: number): boolean =>
    turns.some((turn) => turn.running || turn.sequence > handoverSequence)
  const unopened = journal.submissions().filter((entry) => {
    const handover = ownTurnHandover(entry.clientMessageId)
    return (
      sendStopCanTakeBack(entry) &&
      entry.acceptedSequence !== undefined &&
      entry.acceptedSequence < stop.sequence &&
      handover !== undefined &&
      !openedSince(handover)
    )
  })
  const withdrawn = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
    surface: 'rejection'
  })
  for (const entry of unopened) {
    await journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'rejected',
      ...withdrawn,
      fence,
      recovered: true
    })
  }
}
