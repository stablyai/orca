// The provider child behind a conversation, kept as its own record on the conversation's entry.
//
// The entry is the conversation and outlives any number of children. A child enters only when an
// attach has fully succeeded, and leaves only through `endProviderChild`, which every ending shares:
// an exit, a failed re-attach, a Stop and an eviction. Each is matched on the child's generation
// and fence, so an ending that arrives late for an older child cannot end a newer one.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
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

/** How a start someone waited on ended: proven, or the child is gone. */
export type StructuredAgentSessionChildStartOutcome = 'ready' | 'ended'

const startWaits = new WeakMap<
  StructuredAgentSessionProviderChild,
  PromiseWithResolvers<StructuredAgentSessionChildStartOutcome>
>()

function settleStartWait(
  child: StructuredAgentSessionProviderChild,
  outcome: StructuredAgentSessionChildStartOutcome
): void {
  startWaits.get(child)?.resolve(outcome)
  startWaits.delete(child)
}

/** Settles when the session's child leaves `starting`; at once when it has none starting. Every
 *  move out of `starting` is made in this file, so none can leave a waiter behind. */
export function providerChildStartSettled(
  session: Pick<ChildBearer, 'child'> | undefined
): Promise<StructuredAgentSessionChildStartOutcome> {
  const child = session?.child
  if (!child) {
    return Promise.resolve('ended')
  }
  if (child.phase !== 'starting') {
    return Promise.resolve('ready')
  }
  let wait = startWaits.get(child)
  if (!wait) {
    wait = Promise.withResolvers()
    startWaits.set(child, wait)
  }
  return wait.promise
}

/** For the end of a successful attach only: a failed one never wrote a child to take back. */
export function indexProviderChild(
  session: ChildBearer,
  child: StructuredAgentSessionProviderChild
): void {
  const previous = session.child
  if (previous && previous !== child) {
    if (sameProviderChild(previous, child)) {
      carryStartWait(previous, child)
    } else {
      settleStartWait(previous, 'ended')
    }
  }
  session.child = child
}

/** A re-attach rebuilds the same child (a second window, a phone, a reconnect): its start is still
 *  the one waited on. */
function carryStartWait(
  from: StructuredAgentSessionProviderChild,
  to: StructuredAgentSessionProviderChild
): void {
  const wait = startWaits.get(from)
  startWaits.delete(from)
  if (!wait) {
    return
  }
  if (to.phase !== 'starting') {
    wait.resolve('ready')
    return
  }
  const existing = startWaits.get(to)
  if (existing) {
    void existing.promise.then(wait.resolve)
  } else {
    startWaits.set(to, wait)
  }
}

export function markProviderChildStarted(
  session: ChildBearer,
  identity: StructuredAgentSessionProviderChildIdentity
): boolean {
  const child = matchingChild(session, identity)
  if (child) {
    child.phase = 'ready'
    settleStartWait(child, 'ready')
  }
  return child !== null
}

/** This runtime holds a child at `fence` whose process its adapter still sees running: first-hand
 *  proof of life that needs no PID probe. A previous runtime's child is never on record here. */
export function holdsLiveProviderChild(
  session: Pick<ChildBearer, 'child'> | undefined,
  fence: number,
  processLive: (acquisitionGeneration: string) => boolean
): boolean {
  const child = session?.child
  return (
    !!child && child.fence === fence && child.generation !== null && processLive(child.generation)
  )
}

/** The host's conversations, as lease renewal reads their children. */
export type ProviderChildSessions = {
  get(sessionId: string): Pick<ChildBearer, 'child'> | undefined
}

/** Lease renewal's held-child read, from the host's child record and the adapter's own handle. */
export function heldProviderChildReader(
  sessions: ProviderChildSessions,
  adapter: Pick<StructuredAgentSessionAdapter, 'holdsLiveProviderProcess'> | undefined
): (sessionId: string, fence: number) => boolean {
  return (sessionId, fence) =>
    holdsLiveProviderChild(
      sessions.get(sessionId),
      fence,
      (generation) => adapter?.holdsLiveProviderProcess?.(sessionId, generation) === true
    )
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
  settleStartWait(child, 'ended')
  session.lastEndedChild = {
    ...ended,
    ...(child.startedFor === undefined ? {} : { startedFor: child.startedFor }),
    endedAt: ended.endedAt ?? session.journal.cursor()
  }
  return true
}

/** The conversation's last start died before it proved itself, and nothing started since. Only a
 *  send retries it: a view or an exit recovery would respawn into the same failure, adding a row. */
export function failedProviderChildStart(
  session: Pick<ChildBearer, 'child' | 'lastEndedChild'>
): StructuredAgentSessionEndedChild | null {
  const ended = session.lastEndedChild
  return !session.child && ended?.duringStartup && ended.cause !== 'user-stop' ? ended : null
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
