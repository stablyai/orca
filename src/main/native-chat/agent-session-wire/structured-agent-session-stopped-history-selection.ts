// Select carried history inside serialized handover to deliver each message once across devices.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentSessionSendCarriesStoppedHistory,
  agentSessionSendDeliversStoppedHistory,
  agentSessionStoppedHistoryOwed,
  selectStoppedHistory,
  type StoppedHistoryDelivery
} from '../../../shared/agent-session-stopped-history'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

type StoppedHistoryContext = {
  journal: Pick<AgentSessionJournal, 'submissions' | 'itemBody' | 'stoppedHistoryCarried'> & {
    context: Pick<AgentSessionJournal['context'], 'floor'>
  }
}

/** Only personal words-only turn-opening sends carry history; steers may never record it. */
export function carriedStoppedHistory(
  ctx: StoppedHistoryContext,
  turnScope: AgentJournalTurnScope,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): StoppedHistoryDelivery | null {
  if (
    turnScope.kind !== 'thread' ||
    !agentSessionSendDeliversStoppedHistory(submission, body) ||
    !agentSessionSendCarriesStoppedHistory(body)
  ) {
    return null
  }
  return selectStoppedHistory(
    agentSessionStoppedHistoryOwed({
      submissions: ctx.journal.submissions(),
      carried: ctx.journal.stoppedHistoryCarried(),
      clearSequence: ctx.journal.context.floor()?.sequence ?? 0,
      body: (id) => ctx.journal.itemBody(agentJournalSubmissionKey(id))
    }),
    body
  )
}
