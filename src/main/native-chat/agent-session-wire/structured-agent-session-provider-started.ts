// The host's half of a provider child proving its start.
//
// A publish-first acquire hands the host a child that has answered nothing yet, so the record
// keeps only the saved options the reservation carried. This is where the host learns the start
// landed, flips the session to `ready`, and persists what the child now reports as fact through
// the same record write a user's option change takes. Bookkeeping never gates the user: a failed
// write is reported and the session stays usable.
//
// This runs under the session's own serialized step, which its close and sends wait on, so it
// asks the provider nothing: the event carries what the child proved.

import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { StructuredAgentSessionStartedEvent } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { nativeSessionOptionsFromReport } from './structured-agent-session-option-restoration'

export type StructuredAgentSessionProviderStartedContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus?: (sessionId: string) => void
  restartReleaseGrace: (sessionId: string) => void
  onBarrierError: (sessionId: string, error: unknown) => void
}

export function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<void> {
  // Serialized behind the attach that published this child, so the lease it proved is committed.
  return context.serialize(event.sessionId, async () => {
    const session = context.sessions.get(event.sessionId)
    if (
      !session?.hasProviderChild ||
      session.fence !== event.fence ||
      session.acquisitionGeneration !== event.acquisitionGeneration
    ) {
      return
    }
    session.providerChildPhase = 'ready'
    // Prompts held for the start are written now but open a turn only on their echo; a release
    // tick in between would stop the child before it runs them.
    context.restartReleaseGrace(event.sessionId)
    try {
      await persistStartedOptions(context, event)
    } catch (error) {
      context.onBarrierError(event.sessionId, error)
    } finally {
      context.publishStatus?.(event.sessionId)
    }
  })
}

async function persistStartedOptions(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<void> {
  const { store } = context.deps
  const record = store.getRecord(event.sessionId)
  if (
    !record ||
    record.lease.runtimeFence !== event.fence ||
    !agentSessionLeaseAdmitsWriter(record.lease)
  ) {
    return
  }
  await store.replaceSessionOptions({
    sessionId: event.sessionId,
    fence: event.fence,
    options: nativeSessionOptionsFromReport({
      reported: event.reportedOptions,
      restoreSkipped: event.restoreSkippedOptions,
      ...(record.options ? { priorOptions: record.options } : {})
    }),
    now: context.now()
  })
}
