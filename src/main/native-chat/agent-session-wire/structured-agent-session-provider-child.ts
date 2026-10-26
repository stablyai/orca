// Match child endings by generation/fence so stale exits cannot end newer children; conversation state outlives them.

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

/** Conversation writes use the record fence; provider writes retain the child’s acquisition fence. */
export function structuredAgentSessionConversationFence(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): number {
  return store.getRecord(sessionId)?.lease.runtimeFence ?? 0
}

/** Index only successful attaches; failures have no child to remove. */
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

/** Current adapter-held children prove life without PID probes; previous runtimes prove nothing here. */
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

export type ProviderChildSessions = {
  get(sessionId: string): Pick<ChildBearer, 'child'> | undefined
}

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

/** Requested close retains its Stop boundary; spontaneous exit uses the current cursor. */
export function endProviderChild(
  session: ChildBearer,
  ended: Omit<StructuredAgentSessionEndedChild, 'endedAt' | 'startedFor'> & {
    endedAt?: AgentJournalCursor
  }
): boolean {
  if (!recordProviderChildEnd(session, ended)) {
    return false
  }
  session.child = null
  return true
}

/** Mark ended for all readers while retaining the child for its own teardown. */
export function recordProviderChildEnd(
  session: ChildBearer,
  ended: Omit<StructuredAgentSessionEndedChild, 'endedAt' | 'startedFor'> & {
    endedAt?: AgentJournalCursor
  }
): boolean {
  const child = matchingChild(session, ended)
  if (!child) {
    return false
  }
  session.lastEndedChild = {
    ...ended,
    ...(child.startedFor === undefined ? {} : { startedFor: child.startedFor }),
    endedAt: ended.endedAt ?? session.journal.cursor()
  }
  return true
}

/** Only sends retry failed startup; views/exit recovery must not respawn the same failure. */
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
