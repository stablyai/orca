// An end the adapter could not prove. The child may still be running, so the host keeps it and owes
// its stop: nothing writes to it or starts beside it until a retry proves the exit or the exit
// itself is seen, and a message sent meanwhile waits under the wind-down row. When that stop lands
// it settles as the end that was reported, not as a stop anyone asked for.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionEndUnprovenEvent } from './structured-agent-session-adapter'
import {
  captureUnfinishedStructuredAgentSessionWork,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionOwedWindDown,
  StructuredAgentSessionProviderChildIdentity,
  StructuredAgentSessionReportedEnd
} from './structured-agent-session-host-types'
import {
  pendingProviderChildWindDown,
  sameProviderChild
} from './structured-agent-session-provider-child'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'

type UnprovenEndSession = Pick<
  StructuredAgentSessionHostSession,
  'child' | 'owesProviderChildWindDown' | 'journal'
>

export type StructuredAgentSessionUnprovenEndContext = {
  sessions: Map<string, UnprovenEndSession>
  now: () => number
  publishStatus?: (sessionId: string) => void
  wakeDelivery?: (sessionId: string) => void
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
}

/** For a caller inside the session's serialize. A report for any other child is stale. */
export function recordUnprovenStructuredAgentSessionEndUnderSerialize(
  context: Omit<StructuredAgentSessionUnprovenEndContext, 'serialize'>,
  sessionId: string,
  ended: StructuredAgentSessionProviderChildIdentity,
  report: Pick<StructuredAgentSessionReportedEnd, 'reason' | 'failure'>
): void {
  const session = context.sessions.get(sessionId)
  const child = session?.child
  if (!session || !child || !sameProviderChild(child, ended)) {
    return
  }
  const cursor = session.journal.cursor()
  // A stop someone asked for keeps its cause and ask; the end only adds that it failed.
  const owed = pendingProviderChildWindDown(session)
  // The rule an observed exit uses: an idle approval or question left open is not interrupted work.
  const interruptedWork = unfinishedStructuredAgentSessionWorkWasInterrupted(
    captureUnfinishedStructuredAgentSessionWork(session.journal),
    session.journal,
    context.now()
  )
  session.owesProviderChildWindDown = owed
    ? { ...owed, failedAt: cursor }
    : {
        generation: child.generation,
        fence: child.fence,
        cause: 'host-stop',
        requestedAt: cursor,
        failedAt: cursor,
        ended: {
          reason: report.reason,
          ...(report.failure ? { failure: report.failure } : {}),
          interruptedWork
        }
      }
  context.publishStatus?.(sessionId)
  context.wakeDelivery?.(sessionId)
}

export function recordUnprovenStructuredAgentSessionEnd(
  context: StructuredAgentSessionUnprovenEndContext,
  event: StructuredAgentSessionEndUnprovenEvent
): Promise<void> {
  return context.serialize(event.sessionId, async () =>
    recordUnprovenStructuredAgentSessionEndUnderSerialize(
      context,
      event.sessionId,
      { generation: event.acquisitionGeneration, fence: event.fence },
      { reason: event.reason, ...(event.failure ? { failure: event.failure } : {}) }
    )
  )
}

/** Whether an exit of `child` is what the stop owed for it was waiting on. */
export function structuredAgentSessionOwedStopAwaitsExit(
  session: Pick<StructuredAgentSessionHostSession, 'child' | 'owesProviderChildWindDown'>,
  child: StructuredAgentSessionProviderChildIdentity
): boolean {
  const owed = pendingProviderChildWindDown(session)
  return owed !== undefined && sameProviderChild(owed, child)
}

/** How the stop that lands settles the child's work: as the reported end, with the row that says
 *  why when work was in flight, or as the stop that was asked for, which shows none. */
export function structuredAgentSessionStopSettlement(input: {
  sessionId: string
  fence: number
  owed: StructuredAgentSessionOwedWindDown | undefined
  session: Pick<StructuredAgentSessionHostSession, 'lastEndedChild' | 'journal'>
  record: AgentSessionRecord | null
}) {
  const { sessionId, fence, owed, session } = input
  const reported = owed?.ended
  if (!owed || !reported) {
    return {
      settlementId: `expected-close:${sessionId}:${fence}:${owed?.generation ?? 'unknown'}`,
      pendingSubmissionReason: 'provider_closed_before_acknowledgement',
      showUnexpectedExitOutcome: false
    }
  }
  const lastEnded = session.lastEndedChild
  const duringStartup =
    lastEnded !== undefined && sameProviderChild(lastEnded, owed) && lastEnded.duringStartup
  return {
    // The same settlement an exit of this child writes, so the two never both land.
    settlementId: `provider-exit:${sessionId}:${owed.fence}:${owed.generation}`,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement',
    showUnexpectedExitOutcome: duringStartup || reported.interruptedWork,
    ...(reported.failure ? { exitFailure: reported.failure } : {}),
    failureTextContext: structuredAgentSessionFailureWordsContext(input.record, session.journal),
    ...(duringStartup ? { exitedDuringStartup: { generation: owed.generation } } : {})
  }
}
