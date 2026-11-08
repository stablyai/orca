import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalCurrentWorkAuthority, JournalObserverResult } from './journal-observer-read'

export type JournalWorkRead =
  | { kind: 'state' }
  | { kind: 'turn' }
  | { kind: 'item'; itemId: string }
  | { kind: 'send'; submission: AgentJournalSubmission }
  | { kind: 'attempt-ended'; clientMessageId: string }

export type JournalWorkReadResult =
  | { kind: 'state'; state: JournalObserverResult['work'] }
  | {
      kind: 'turn'
      activeTurn: JournalObserverResult['work']['activeTurn']
      working: boolean
    }
  | { kind: 'item'; current: boolean }
  | {
      kind: 'send'
      generationEnded: boolean
      owesSend: boolean
      handsOver: boolean
      published: AgentJournalSubmission
    }
  | { kind: 'attempt-ended'; ended: boolean }

export type JournalWorkAnswer<K extends JournalWorkRead['kind']> = Extract<
  JournalWorkReadResult,
  { kind: K }
>

export type JournalWorkReader = <K extends JournalWorkRead['kind']>(
  operation: Extract<JournalWorkRead, { kind: K }>
) => Promise<JournalWorkAnswer<K>>

export type JournalSqlWorkRead = {
  authority: JournalCurrentWorkAuthority
  operation: JournalWorkRead
}

export type JournalSqlWorkResult = {
  cursor: AgentJournalCursor
  physicalCursor: AgentJournalCursor
  authority: JournalCurrentWorkAuthority
  result: JournalWorkReadResult
}
