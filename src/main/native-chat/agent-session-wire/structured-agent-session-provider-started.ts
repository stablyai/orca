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
import type {
  StructuredAgentSessionOptionsSkippedEvent,
  StructuredAgentSessionStartedEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { nativeSessionOptionsFromReport } from './structured-agent-session-option-restoration'
import { markProviderChildStarted } from './structured-agent-session-provider-child'

export type StructuredAgentSessionProviderStartedContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus?: (sessionId: string) => void
}

export function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<void> {
  // Serialized behind the attach that published this child, so the lease it proved is committed.
  return context.serialize(event.sessionId, async () => {
    const session = context.sessions.get(event.sessionId)
    if (
      !session ||
      !markProviderChildStarted(session, {
        generation: event.acquisitionGeneration,
        fence: event.fence
      })
    ) {
      return
    }
    noteStructuredAgentSessionProviderStarted(context.deps, event.sessionId)
    try {
      await persistStartedOptions(context, event)
    } catch (error) {
      context.deps.logger.warn('recording what a started provider reported failed', {
        scope: 'provider-started-options',
        sessionId: event.sessionId,
        error
      })
    } finally {
      context.publishStatus?.(event.sessionId)
    }
  })
}

/** A proven start shows the agent's program exists and may mean a sign-in was fixed, so the
 *  catalog's held reason is re-checked by the next read's probe sooner; the probe decides. */
export function noteStructuredAgentSessionProviderStarted(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string
): void {
  const record = deps.store.getRecord(sessionId)
  if (record) {
    deps.modelCatalog?.providerStarted(record)
  }
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
      ...(event.retiredOptions ? { retired: event.retiredOptions } : {}),
      ...(record.options ? { priorOptions: record.options } : {})
    }),
    now: context.now()
  })
}

/** A running child showed saved options it cannot run: the record drops them, as a start that
 *  skipped them would, so the next start runs the provider's own. Reported, never thrown. */
export function settleStructuredAgentSessionOptionsSkipped(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsSkippedEvent
): Promise<void> {
  return context.serialize(event.sessionId, async () => {
    const { store } = context.deps
    const record = store.getRecord(event.sessionId)
    if (
      !record?.options ||
      record.lease.runtimeFence !== event.fence ||
      !agentSessionLeaseAdmitsWriter(record.lease)
    ) {
      return
    }
    const options = { ...record.options }
    for (const [key, value] of Object.entries(event.options)) {
      // A pick made since the child launched is the user's, whatever the child showed.
      if (options[key] === value) {
        delete options[key]
      }
    }
    try {
      await store.replaceSessionOptions({
        sessionId: event.sessionId,
        fence: event.fence,
        options,
        now: context.now()
      })
    } catch (error) {
      context.deps.logger.warn('dropping a saved option the provider cannot run failed', {
        scope: 'provider-options-skipped',
        sessionId: event.sessionId,
        error
      })
    } finally {
      context.publishStatus?.(event.sessionId)
    }
  })
}
