// The provider child behind a conversation, kept as its own record on the conversation's entry.
//
// The entry is the conversation and outlives any number of children. A child enters only when an
// attach has fully succeeded, and leaves only through `endProviderChild`, which every ending shares:
// an exit, a failed re-attach, a Stop and an eviction. Each is matched on the child's generation
// and fence, so an ending that arrives late for an older child cannot end a newer one. Being that
// one place is also what lets a waiter hear every ending, whichever way the adapter reported it.

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

type ChildEndWaiter = { identity: StructuredAgentSessionProviderChildIdentity; resolve: () => void }

const childEndWaiters = new WeakMap<ChildBearer, ChildEndWaiter[]>()

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
  // A re-attach to the same child keeps its waiters; any other child is gone.
  releaseChildEndWaiters(session, (identity) => !sameChild(identity, child))
}

/** Resolves when this child is no longer the conversation's, at once when it already is not. */
export function providerChildEnded(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): Promise<void> {
  if (!matchingChild(session, identity)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const waiters = childEndWaiters.get(session) ?? []
    waiters.push({ identity, resolve })
    childEndWaiters.set(session, waiters)
  })
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

export function endProviderChild(
  session: ChildBearer,
  ended: Omit<StructuredAgentSessionEndedChild, 'endedAt'>
): boolean {
  if (!matchingChild(session, ended)) {
    return false
  }
  session.child = null
  session.lastEndedChild = { ...ended, endedAt: session.journal.cursor() }
  releaseChildEndWaiters(session, () => true)
  return true
}

function releaseChildEndWaiters(
  session: ChildBearer,
  ended: (identity: StructuredAgentSessionProviderChildIdentity) => boolean
): void {
  const waiters = childEndWaiters.get(session)
  if (!waiters) {
    return
  }
  const remaining = waiters.filter((waiter) => !ended(waiter.identity))
  for (const waiter of waiters) {
    if (!remaining.includes(waiter)) {
      waiter.resolve()
    }
  }
  if (remaining.length > 0) {
    childEndWaiters.set(session, remaining)
  } else {
    childEndWaiters.delete(session)
  }
}

function matchingChild(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): StructuredAgentSessionProviderChild | null {
  const { child } = session
  return child && sameChild(child, identity) ? child : null
}

function sameChild(
  a: StructuredAgentSessionProviderChildIdentity,
  b: StructuredAgentSessionProviderChildIdentity
): boolean {
  return a.generation === b.generation && a.fence === b.fence
}
