// The host's half of a provider child proving its start.
//
// A publish-first acquire hands the host a child that has answered nothing yet, so the record
// keeps only the saved options the reservation carried, and the delivery loop hands it nothing.
// This is where the host learns the start landed: the child turns `ready`, its startup attempt
// ends, and the loop wakes to hand over what was queued meanwhile. Only once that handover is done
// is what the child reports persisted, in a step of its own, so bookkeeping never sits between a
// ready child and the user's first message; a failed write is reported, never thrown. Every report
// is persisted only if no pick or later report came after its read (`option-revisions`).
//
// These run under the session's own serialized steps, which its close and sends wait on, so they
// ask the provider nothing: the event carries what the child proved.

import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type {
  StructuredAgentSessionOptionsReportedEvent,
  StructuredAgentSessionOptionsSkippedEvent,
  StructuredAgentSessionStartedEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { nativeSessionOptionsFromReport } from './structured-agent-session-option-restoration'
import {
  markProviderChildStarted,
  sameProviderChild
} from './structured-agent-session-provider-child'
import type { StructuredAgentSessionOptionRevisions } from './structured-agent-session-option-revisions'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'

export type StructuredAgentSessionProviderStartedContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus?: (sessionId: string) => void
  runtimeState: {
    startupAttempts: Pick<StructuredAgentSessionStartupAttempts, 'ready'>
    optionRevisions: Pick<
      StructuredAgentSessionOptionRevisions,
      'admitReport' | 'advance' | 'isNewest'
    >
  }
  /** The barrier lifts: what was accepted while the child started is handed over now. Settles once
   *  the loop has handed over all it can. */
  wakeDelivery: (sessionId: string) => Promise<void>
}

type ReportedOptions = Omit<StructuredAgentSessionOptionsReportedEvent, 'type'>

export async function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<void> {
  // On arrival, before any wait: reports are admitted in the order the child made them.
  const admitted = admitReportedOptions(context, event)
  // Serialized behind the attach that published this child, so the lease it proved is committed.
  const started = await context.serialize(event.sessionId, async () => {
    const session = context.sessions.get(event.sessionId)
    const child = { generation: event.acquisitionGeneration, fence: event.fence }
    // A stale child's proof starts nothing: the barrier stays on the child the host holds.
    if (!session || !markProviderChildStarted(session, child)) {
      return null
    }
    context.runtimeState.startupAttempts.ready(event.sessionId, child)
    const delivered = context.wakeDelivery(event.sessionId)
    noteStructuredAgentSessionProviderStarted(context.deps, event.sessionId)
    context.publishStatus?.(event.sessionId)
    return { delivered }
  })
  if (!started) {
    return
  }
  // Not awaited: the adapter's next event may be what the handover itself waits on.
  void started.delivered.then(() => persistReportedOptions(context, event, admitted))
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

/** What a ready child reports later, such as a read that came after its start: persisted as the
 *  start's report is, never ahead of a send. */
export function settleStructuredAgentSessionOptionsReported(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsReportedEvent
): Promise<void> {
  return persistReportedOptions(context, event, admitReportedOptions(context, event))
}

function admitReportedOptions(
  context: StructuredAgentSessionProviderStartedContext,
  event: ReportedOptions
): number | null {
  return context.runtimeState.optionRevisions.admitReport(event.sessionId, event.optionRevision)
}

/** Non-fatal, and only for the child that reported, while its report is still the newest word: a
 *  pick or a later report since it was admitted is newer than what it read. */
function persistReportedOptions(
  context: StructuredAgentSessionProviderStartedContext,
  event: ReportedOptions,
  admitted: number | null
): Promise<void> {
  if (admitted === null) {
    return Promise.resolve()
  }
  return context
    .serialize(event.sessionId, async () => {
      const child = context.sessions.get(event.sessionId)?.child
      const record = context.deps.store.getRecord(event.sessionId)
      if (
        !child ||
        !sameProviderChild(child, {
          generation: event.acquisitionGeneration,
          fence: event.fence
        }) ||
        !record ||
        record.lease.runtimeFence !== event.fence ||
        !agentSessionLeaseAdmitsWriter(record.lease) ||
        !context.runtimeState.optionRevisions.isNewest(
          event.sessionId,
          event.optionRevision,
          admitted
        )
      ) {
        return
      }
      try {
        await context.deps.store.replaceSessionOptions({
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
      } finally {
        context.publishStatus?.(event.sessionId)
      }
    })
    .catch((error: unknown) => {
      context.deps.logger.warn('recording what a started provider reported failed', {
        scope: 'provider-started-options',
        sessionId: event.sessionId,
        error
      })
    })
}

/** A running child showed saved options it cannot run: the record drops them, as a start that
 *  skipped them would, so the next start runs the provider's own. Reported, never thrown. */
export function settleStructuredAgentSessionOptionsSkipped(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsSkippedEvent
): Promise<void> {
  // A report read before the child showed this is out of date: it would write the value back.
  context.runtimeState.optionRevisions.advance(event.sessionId)
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
