// Derive withdrawals at settlement execution so retries read the same landed journal state.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentType } from '../../../shared/agent-status-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'

/** Missing methods withdraw nothing. */
export type UnopenedSendJournal = {
  agent?: AgentType
  queuedMessages?: Pick<AgentSessionJournal['queuedMessages'], 'userStopInForce'>
  snapshot: () => Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  submissions?: () => (Pick<
    AgentJournalSubmission,
    | 'clientMessageId'
    | 'dispatchState'
    | 'recovered'
    | 'handoverRecorded'
    | 'handedOverAt'
    | 'acceptedSequence'
  > & { reason?: string | null; fence?: number })[]
  resolveDispatch?: AgentSessionJournal['resolveDispatch']
}

/** Only in-flight or locally unknown sends; never unhanded cards or recovered sends from an earlier process. */
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

/** Codex records prompts when their turn starts; a handed-over turn-opening send with no later turn never ran.
 * Only an effective personal Stop withdraws it; steers and sends without recorded handover remain uncertain. */
export async function withdrawCodexSendsNoTurnOpenedFor(
  journal: UnopenedSendJournal,
  fence: number
): Promise<void> {
  if (!journal.resolveDispatch) {
    return
  }
  for (const resolution of codexUnopenedSendResolutions(journal, fence)) {
    await journal.resolveDispatch(resolution)
  }
}

export function codexUnopenedSendResolutions(
  journal: UnopenedSendJournal,
  fence: number
): ResolveDispatchInput[] {
  const stop = journal.agent === 'codex' ? journal.queuedMessages?.userStopInForce() : null
  if (!stop || !journal.submissions) {
    return []
  }
  const { items } = journal.snapshot()
  const turns = items.flatMap((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn ? [{ running: turn.state === 'running', sequence: item.sequence }] : []
  })
  // Thread-scoped handover opened its own turn; no turn since that position proves it never ran.
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
  return unopened.map((entry): ResolveDispatchInput => ({
    clientMessageId: entry.clientMessageId,
    state: 'rejected',
    ...withdrawn,
    fence,
    recovered: true
  }))
}
