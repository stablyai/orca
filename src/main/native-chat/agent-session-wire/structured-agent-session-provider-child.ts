// The provider child behind a conversation, kept as its own record on the conversation's entry.
//
// The entry is the conversation and outlives any number of children. A child enters only when an
// attach has fully succeeded, and leaves only through `endProviderChild`, which every ending shares:
// an exit, a failed re-attach, a Stop and an eviction. Each is matched on the child's generation
// and fence, so an ending that arrives late for an older child cannot end a newer one.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'

type ChildBearer = Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'> & {
  journal: Pick<AgentSessionJournal, 'cursor'>
}

/** The fence a conversation write carries: the record's, which is where the next child starts. A
 *  child's own writes carry `child.fence`, which equals it while that child holds the lease. */
export function structuredAgentSessionConversationFence(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): number {
  return store.getRecord(sessionId)?.lease.runtimeFence ?? 0
}

/** For the end of a successful attach only: a failed one never wrote a child to take back. */
export function indexProviderChild(
  session: ChildBearer,
  child: StructuredAgentSessionProviderChild
): void {
  session.child = child
}

export function markProviderChildStarted(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): boolean {
  const child = matchingChild(session, identity)
  if (child) {
    child.phase = 'ready'
  }
  return child !== null
}

/** `endedAt` is a close's ask; an exit of the child's own ends where the journal stands. */
export function endProviderChild(
  session: ChildBearer,
  ended: Omit<StructuredAgentSessionEndedChild, 'endedAt' | 'startedFor'> & {
    endedAt?: AgentJournalCursor
  }
): boolean {
  const child = matchingChild(session, ended)
  if (!child) {
    return false
  }
  session.child = null
  session.lastEndedChild = {
    ...ended,
    ...(child.startedFor === undefined ? {} : { startedFor: child.startedFor }),
    // Its failed start is already on the message it was for.
    ...(child.startFailed ? { startFailureRecorded: true as const } : {}),
    endedAt: ended.endedAt ?? session.journal.cursor()
  }
  return true
}

/** The adapter settled this child's start without proving it; its end follows. */
export function markProviderChildStartFailed(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): void {
  const child = matchingChild(session, identity)
  if (child) {
    child.startFailed = true
  }
}

/** The conversation's last start died before it proved itself, nothing started since, and the
 *  delivery loop has not yet recorded it on a message. Only a message's next try starts again: a
 *  view or an exit recovery would respawn into the same failure. */
export function failedProviderChildStart(
  session: Pick<ChildBearer, 'child' | 'lastEndedChild'>
): StructuredAgentSessionEndedChild | null {
  const ended = session.lastEndedChild
  return !session.child &&
    ended?.duringStartup &&
    ended.cause !== 'user-stop' &&
    !ended.startFailureRecorded
    ? ended
    : null
}

/** Whoever ends that start next, its failure is recorded once. */
export function markProviderChildStartFailureRecorded(
  session: Pick<ChildBearer, 'lastEndedChild'>,
  identity: StructuredAgentSessionProviderChildIdentity
): void {
  const ended = session.lastEndedChild
  if (ended?.generation === identity.generation && ended.fence === identity.fence) {
    ended.startFailureRecorded = true
  }
}

export function sameProviderChild(
  a: StructuredAgentSessionProviderChildIdentity,
  b: StructuredAgentSessionProviderChildIdentity
): boolean {
  return a.generation === b.generation && a.fence === b.fence
}

function matchingChild(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): StructuredAgentSessionProviderChild | null {
  const { child } = session
  return child && sameProviderChild(child, identity) ? child : null
}
