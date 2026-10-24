import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { StructuredPointerSubmission } from './structured-pointer-operation-id'
import type { StructuredDispatchState } from './structured-session-pointer-delivery'

export type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerTarget = {
  sessionId: string
  /**
   * The dispatch whose mailbox this is, or null for direct peer mail addressed to the worker's own
   * handle outside any dispatch. Nothing downstream needs a dispatch to deliver — it only names
   * the caller on the operation row and the mail's source — so a worker between dispatches is
   * nudged, not dropped.
   */
  dispatchId: string | null
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'held' }
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued' }
  | { kind: 'unattached' }

export type StructuredPointerSessionFacts = {
  /** Current-context sends, oldest first: what the lane's own sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
}

export type StructuredMailboxPointerHost = {
  /** `null` when the session cannot be read. */
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  hasActionablePromptNow: (sessionId: string) => boolean | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
}
