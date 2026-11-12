import type { JournalSqlQueueFacts } from './journal-sql-queue-read'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalCurrentWorkAuthority, JournalObserverResult } from './journal-observer-read'

export type JournalWorkRead =
  | { kind: 'state' }
  | {
      kind: 'input'
      now: number
      facts: JournalSqlQueueFacts
      allowSteer: boolean
      resolved?: JournalSqlWorkResult
    }
  | { kind: 'opening-send'; fence: number }
  | { kind: 'turn' }
  | { kind: 'child-work' }
  | { kind: 'item'; itemId: string }
  | { kind: 'send'; submission: AgentJournalSubmission }
  | { kind: 'attempt-ended'; clientMessageId: string }

export type JournalWorkReadResult =
  | { kind: 'opening-send'; opening: boolean }
  | { kind: 'state'; state: JournalObserverResult['work'] }
  | {
      kind: 'input'
      state: JournalObserverResult['work']
      queue: { card: QueuedMessageRow | null } | { failure: JournalSqlFailure }
    }
  | {
      kind: 'child-work'
      working: boolean
      activeTurn: boolean
      actionablePrompt: boolean
      newestTurnCompletedAt: number | undefined
    }
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
