import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { AgentSessionJournalError } from '../../agent-session-journal/writing/journal-write-guards'
import type {
  JournalWorkRead,
  JournalWorkAnswer
} from '../../agent-session-journal/journal-work-read'
import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'
import type { StructuredAgentSessionCurrentWorkHost } from './structured-agent-session-host-current-work'
import { structuredAgentSessionHandoverAuthority } from '../delivery/structured-agent-session-handing-over'
import type { JournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'

type WorkSession = Omit<
  NonNullable<ReturnType<StructuredAgentSessionCurrentWorkHost['sessions']['get']>>,
  'journal'
> & { journal: AgentSessionJournal }

type WorkHost = {
  store: StructuredAgentSessionCurrentWorkHost['store']
  sessions: { get(sessionId: string): WorkSession | undefined }
}

export async function readHostStructuredAgentSessionWork<K extends JournalWorkRead['kind']>(
  host: WorkHost,
  sessionId: string,
  operation: Extract<JournalWorkRead, { kind: K }>
): Promise<JournalWorkAnswer<K>> {
  const session = host.sessions.get(sessionId)
  if (!session) {
    throw new AgentSessionJournalError('journal_closed', `the journal for ${sessionId} is closed`)
  }
  const { journal } = session
  return journal.readWork(
    () => captureHostStructuredAgentSessionWork(host, sessionId, journal),
    operation
  )
}

export function captureHostStructuredAgentSessionWork(
  host: WorkHost,
  sessionId: string,
  journal: AgentSessionJournal
): JournalCurrentWorkAuthority {
  const current = host.sessions.get(sessionId)
  if (current?.journal !== journal) {
    throw new AgentSessionJournalError(
      'journal_closed',
      `the journal for ${sessionId} was replaced`
    )
  }
  const child = current.child
  const held = child?.heldSends?.()
  return {
    handle: journal.observationHandle(),
    record: host.store.getConversation(sessionId),
    ended: current.lastEndedChild,
    replaced: host.store.replacedRuntime(sessionId),
    child:
      child === null || child === undefined
        ? child
        : { fence: child.fence, heldSends: held && [...held] },
    ...structuredAgentSessionHandoverAuthority(journal),
    openedThrough: journal.openingCursor(),
    operationalRevision: current.operationalRevision ?? 0
  }
}

export async function readContextStructuredAgentSessionWork<K extends JournalWorkRead['kind']>(
  ctx: Pick<AgentSessionTurnContext, 'readWork'>,
  operation: Extract<JournalWorkRead, { kind: K }>
): Promise<JournalWorkAnswer<K>> {
  if (!ctx.readWork) {
    throw new Error('current-work reader was not bound to this operation')
  }
  return ctx.readWork(operation)
}

export async function readContextStructuredAgentSessionTurnScope(
  ctx: Pick<AgentSessionTurnContext, 'readWork'>
): Promise<AgentJournalTurnScope> {
  return (await readContextStructuredAgentSessionTurn(ctx)).turnScope
}

/** One answer for Stop's live-turn, scope and working checks. */
export async function readContextStructuredAgentSessionTurn(
  ctx: Pick<AgentSessionTurnContext, 'readWork'>
): Promise<{ working: boolean; activeTurnId: string | null; turnScope: AgentJournalTurnScope }> {
  const { activeTurn, working } = await readContextStructuredAgentSessionWork(ctx, {
    kind: 'turn'
  })
  return {
    working,
    activeTurnId: activeTurn?.turnId ?? null,
    turnScope: activeTurn
      ? { kind: 'turn', turnItemId: activeTurn.item.itemId }
      : AGENT_JOURNAL_THREAD_SCOPE
  }
}
