// The provider child behind a conversation, kept as its own record on the conversation's entry.
//
// The entry is the conversation and outlives any number of children. A child enters only when an
// attach has fully succeeded, and leaves only through `endProviderChild`, which every ending shares:
// an exit, a failed re-attach, a Stop and an eviction. Each is matched on the child's generation
// and fence, so an ending that arrives late for an older child cannot end a newer one.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'

type ChildBearer = Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'>

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

export function endProviderChild(
  session: ChildBearer,
  ended: StructuredAgentSessionEndedChild
): boolean {
  if (!matchingChild(session, ended)) {
    return false
  }
  session.child = null
  session.lastEndedChild = ended
  return true
}

function matchingChild(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): StructuredAgentSessionProviderChild | null {
  const { child } = session
  return child && child.generation === identity.generation && child.fence === identity.fence
    ? child
    : null
}
