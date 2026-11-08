import { latestStructuredAgentSessionTurn } from '../../../../shared/agent-session/view/structured-agent-session-live-turn'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { AgentSessionJournalError } from '../../agent-session-journal/writing/journal-write-guards'
import type {
  JournalWorkRead,
  JournalWorkReadResult,
  JournalWorkAnswer
} from '../../agent-session-journal/journal-work-read'
import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'
import {
  contextStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork
} from './structured-agent-session-current-work'
import {
  heldStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkHost
} from './structured-agent-session-host-current-work'
import { structuredAgentSessionHandoverAuthority } from '../delivery/structured-agent-session-handing-over'

type WorkSession = Omit<
  NonNullable<ReturnType<StructuredAgentSessionCurrentWorkHost['sessions']['get']>>,
  'journal'
> & { journal: AgentSessionJournal | SqlAgentSessionJournal }

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
  if (journal instanceof SqlAgentSessionJournal) {
    return journal.readWork(() => {
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
    }, operation)
  }
  return readMemoryWork(
    journal,
    heldStructuredAgentSessionCurrentWork(host.store, sessionId, journal, session),
    operation
  )
}

export async function readContextStructuredAgentSessionWork<K extends JournalWorkRead['kind']>(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork' | 'readWork'>,
  operation: Extract<JournalWorkRead, { kind: K }>
): Promise<JournalWorkAnswer<K>> {
  return ctx.readWork
    ? ctx.readWork(operation)
    : readMemoryWork(ctx.journal, contextStructuredAgentSessionCurrentWork(ctx), operation)
}

export async function readContextStructuredAgentSessionTurnScope(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork' | 'readWork'>
): Promise<AgentJournalTurnScope> {
  return (await readContextStructuredAgentSessionTurn(ctx)).turnScope
}

/** One answer for Stop's live-turn, scope and working checks. */
export async function readContextStructuredAgentSessionTurn(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork' | 'readWork'>
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

function readMemoryWork<K extends JournalWorkRead['kind']>(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  operation: Extract<JournalWorkRead, { kind: K }>
): JournalWorkAnswer<K> {
  const result = readMemoryAnswer(journal, work, operation)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exhaustive switch returns the operation's discriminant.
  return result as JournalWorkAnswer<K>
}

function readMemoryAnswer(
  journal: AgentSessionJournal,
  work: StructuredAgentSessionCurrentWork,
  operation: JournalWorkRead
): JournalWorkReadResult {
  switch (operation.kind) {
    case 'turn':
      return { kind: 'turn', activeTurn: work.activeTurn(), working: work.working() }
    case 'item':
      return { kind: 'item', current: work.isCurrentItem(operation.itemId) }
    case 'send':
      return {
        kind: 'send',
        generationEnded: work.generationEnded(operation.submission),
        owesSend: work.owesSend(operation.submission),
        handsOver: work.handsOver(operation.submission),
        published: work.publishedSubmission(operation.submission)
      }
    case 'attempt-ended':
      return {
        kind: 'attempt-ended',
        ended: journal.queuedMessages.attemptEnded(operation.clientMessageId)
      }
    case 'state':
      return {
        kind: 'state',
        state: {
          liveFence: work.liveFence,
          allowsObservation: work.allowsObservation(),
          working: work.working(),
          owesAnySend: work.owesAnySend(),
          activeTurn: work.activeTurn(),
          latestTurn: work.publishedLatestTurn(
            latestStructuredAgentSessionTurn(journal.statusRead().items)
          ),
          actionablePrompts: work.actionablePrompts(),
          restatedSubmissions: work.restatedSubmissions(),
          viewKey: work.viewKey(),
          workViewKey: work.workViewKey()
        }
      }
  }
}
