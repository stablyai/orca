import type { JournalStopSettleFact } from './journal-writer-host-facts'

export type JournalRequestMark = {
  kind: 'turn' | 'refused-send'
  id: string
  mark: string
  fence: number
  clientMessageId?: string
  turnState?: string
  personStopped?: boolean
  linkedTurnItemId?: string
  linked?: JournalRequestMark
}

export type JournalRequestOutcome = Omit<JournalRequestMark, 'mark' | 'linked'> & {
  outcome: 'failure' | 'interruption'
  linked?: JournalRequestOutcome
}

export type JournalRequestEvent = {
  epoch: string
  sequence: number
  cleared: boolean
  outcomes: JournalRequestOutcome[]
}

export type JournalRequestFailureRead =
  | { kind: 'request-failure'; requestKind: JournalRequestMark['kind']; id: string }
  | { kind: 'running-request'; stopSettle?: JournalStopSettleFact }
