import type { JournalInputOrder } from '../input-order/journal-input-order'
import type { AgentJournalDispatchState } from '../../../../shared/agent-session/journal/agent-session-journal-types'

export type AgentJournalDispatchObservation = {
  state: AgentJournalDispatchState
  recovered: boolean
}

export function latestJournalDispatchObservation(
  journal: {
    inputOrder: Pick<JournalInputOrder, 'latestSubmission'>
  },
  fence: number
): AgentJournalDispatchObservation | null {
  const latest = journal.inputOrder.latestSubmission(fence)
  return latest ? { state: latest.dispatchState, recovered: latest.recovered === true } : null
}
