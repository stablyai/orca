import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  JournalItemAppendInput,
  JournalLifecycleBatchInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalWriterEffect } from './journal-writer-effects'
import type { JournalWriterInputOperation } from './journal-writer-operations'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'

/** The writer chooses the projection epoch; callers identify only their live open handle. */
export type JournalWriterTarget = { sessionId: string; epoch: string; ownerToken: string }

export type JournalWriterCoreOperation =
  | ({ kind: 'item' } & JournalItemAppendInput)
  | { kind: 'tombstone'; identity: AgentJournalItemIdentity; fence: number }
  | { kind: 'lifecycle'; input: JournalLifecycleBatchInput }
  | { kind: 'dispatch'; input: ResolveDispatchInput; onlyIfUnsettled?: true }
  | { kind: 'stop'; event: Omit<JournalStopEvent, 'at'>; fence: number }
  | { kind: 'queue-resume'; fence: number }
  | { kind: 'queue-reopen'; fence: number; since?: number }

export type JournalWriterOperation = JournalWriterCoreOperation | JournalWriterInputOperation

/** No callbacks, pre-folded outcomes, assigned revisions or host-chosen durability cross this port. */
export type JournalWriterCommand = {
  target: JournalWriterTarget
  operation: JournalWriterOperation
  effects?: readonly JournalWriterEffect[]
  /** Host-memory facts; commands that read none may omit them. */
  facts?: JournalWriterHostFacts
  /** The host's clock at admission, so host-staged receipts agree with the row's time. */
  savedAt?: number
}
