/** What the structured mailbox lane needs from a chat host: session reads and admission-checked sends. */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { StructuredPointerSubmission } from './structured-pointer-operation-id'
import type { StructuredDispatchState } from './structured-session-pointer-delivery'

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'held' }
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued' }
  | { kind: 'unattached' }
  /** A check took or a waiter claimed its mail before admission; nothing ran. */
  | { kind: 'obsolete' }

export type StructuredPointerSessionFacts = {
  /** Current-context sends, oldest first: what the lane's own sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
}

export type StructuredMailboxPointerHost = {
  /** `null` when the session cannot be read. */
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  hasActionablePromptNow: (sessionId: string) => boolean | null
  /** False for a conversation the idle sweep closed: it runs no turn. */
  isWorkingNow: (sessionId: string) => boolean
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
    /** Hold rather than steer when a turn is running at admission. */
    holdWhileWorking: boolean
    /** Rechecked at admission: the batch may have been consumed while the send waited. */
    stillOwed: () => boolean
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
}
