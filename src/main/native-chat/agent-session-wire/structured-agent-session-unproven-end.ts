// An end the adapter could not prove. The child may still be running, so the host keeps it on record
// and closing: nothing writes to it or starts beside it, and every later send, start or Stop joins
// that close and retries the kill. The exit that finally ends the record is settled as the end that
// was reported, not as a stop anyone asked for.

import type { StructuredAgentSessionEndUnprovenEvent } from './structured-agent-session-adapter'
import {
  captureUnfinishedStructuredAgentSessionWork,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity,
  StructuredAgentSessionReportedEnd
} from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'

type UnprovenEndSession = Pick<StructuredAgentSessionHostSession, 'child' | 'journal'>

export type StructuredAgentSessionUnprovenEndContext = {
  sessions: Map<string, UnprovenEndSession>
  now: () => number
  publishStatus?: (sessionId: string) => void
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
  // A close a stop already began keeps its cause: it is that stop's to end.
  if (!child.close) {
    child.close = {
      cause: 'host-stop',
      reason: report.reason,
      recorded: Promise.resolve(null),
      requestedAt: session.journal.cursor(),
      reported: {
        reason: report.reason,
        ...(report.failure ? { failure: report.failure } : {}),
        // The rule an observed exit uses: an approval or question left open is not interrupted.
        interruptedWork: unfinishedStructuredAgentSessionWorkWasInterrupted(
          captureUnfinishedStructuredAgentSessionWork(session.journal),
          session.journal,
          context.now()
        )
      }
    }
  }
  context.publishStatus?.(sessionId)
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
