import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  JournalItemAppendInput,
  JournalLifecycleBatchInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalWriterEffect } from './journal-writer-effects'

/** The writer chooses the projection generation; callers identify only their live open handle. */
export type JournalWriterTarget = { sessionId: string; epoch: string; ownerToken: string }

export type JournalWriterOperation =
  | ({ kind: 'item' } & JournalItemAppendInput)
  | { kind: 'tombstone'; identity: AgentJournalItemIdentity; fence: number }
  | { kind: 'lifecycle'; input: JournalLifecycleBatchInput }
  | { kind: 'dispatch'; input: ResolveDispatchInput; onlyIfUnsettled?: true }
  | { kind: 'stop'; event: Omit<JournalStopEvent, 'at'>; fence: number }
  | { kind: 'queue-resume'; fence: number }
  | { kind: 'queue-reopen'; fence: number; since?: number }

/** No callbacks, pre-folded outcomes, assigned revisions or host-chosen durability cross this port. */
export type JournalWriterCommand = {
  target: JournalWriterTarget
  operation: JournalWriterOperation
  effects?: readonly JournalWriterEffect[]
}
