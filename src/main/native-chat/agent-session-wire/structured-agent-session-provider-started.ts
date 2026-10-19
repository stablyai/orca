// Opening records the provider handle and recovers history before delivery; reports never replace picks.

import type {
  StructuredAgentSessionOptionsReportedEvent,
  StructuredAgentSessionStartedEvent
} from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  markProviderChildStarted,
  sameProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import {
  saveStructuredAgentSessionListing,
  saveStructuredAgentSessionStartReadbackListing
} from './structured-agent-session-start-listing'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { recordAgentSessionProviderHandle } from '../../runtime/agent-session-provider-handle-transition'
import { recoverStructuredRewind } from './structured-rewind-recovery'

export type StructuredAgentSessionProviderStartedContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus?: (sessionId: string) => void
  runtimeState: {
    startupAttempts: Pick<StructuredAgentSessionStartupAttempts, 'ready' | 'onClock' | 'readiness'>
    acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  }
  /** The barrier lifts: what was accepted while the child started is handed over now. Settles once
   *  the loop has handed over all it can. */
  wakeDelivery: (sessionId: string) => Promise<void>
  /** Ends a starting child whose start cannot be completed, as its startup limit would. */
  stopStartingChild: (sessionId: string, child: StructuredAgentSessionProviderChildIdentity) => void
}

export async function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent,
  signal?: AbortSignal
): Promise<void> {
  // Serialized behind the attach that published this child, so the lease it proved is committed.
  await context.serialize(event.sessionId, async () => {
    signal?.throwIfAborted()
    const session = context.sessions.get(event.sessionId)
    const child = { generation: event.acquisitionGeneration, fence: event.fence }
    // A stale child's proof starts nothing: the barrier stays on the child the host holds. Nor
    // does one that lost the race to its startup limit: the limit's stop is queued behind this.
    if (
      !session?.child ||
      session.child.phase !== 'starting' ||
      !sameProviderChild(session.child, child) ||
      !context.runtimeState.startupAttempts.onClock(event.sessionId, child)
    ) {
      return null
    }
    if (!(await recordStartedHandle(context, event))) {
      context.stopStartingChild(event.sessionId, child)
      return null
    }
    if (!(await recoverRewindAtStart(context, event.sessionId, session, signal))) {
      context.stopStartingChild(event.sessionId, child)
      return null
    }
    // The limit can pass while recovery ran; its stop ends this child next.
    if (
      !context.runtimeState.startupAttempts.onClock(event.sessionId, child) ||
      !markProviderChildStarted(session, child)
    ) {
      return null
    }
    context.runtimeState.startupAttempts.ready(event.sessionId, child)
    void context.wakeDelivery(event.sessionId)
    noteStructuredAgentSessionProviderStarted(context.deps, event.sessionId)
    if (event.catalogListing) {
      saveStructuredAgentSessionListing(context, event.sessionId, event.catalogListing)
    }
    context.publishStatus?.(event.sessionId)
    return undefined
  })
}

/** A rewind left in doubt is settled by the first child that can read the provider's history:
 *  this one, now that its protocol session is open, before it is handed anything a recovered
 *  rewind would move. One that stays in doubt fails the start, as it would refuse every send. */
async function recoverRewindAtStart(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await recoverStructuredRewind(
      context.deps,
      sessionId,
      session.journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      context.deps.adapter,
      undefined,
      signal
    )
    return true
  } catch (error) {
    if (signal?.aborted) {
      return false
    }
    context.deps.logger.warn('settling a rewind in doubt at the start failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
    return false
  }
}

/** The handle the child's protocol session answered with, recorded before it is handed anything:
 *  without it a later start could not resume what this child ran. False when there is none. */
async function recordStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionStartedEvent
): Promise<boolean> {
  const { store, logger } = context.deps
  const { link } = event
  if (!link) {
    // Only an acquisition that already held its handle may prove its start without one.
    return store.getRecord(event.sessionId)?.lease.provenHandleLinkId != null
  }
  try {
    await store.transitionHandoff(event.sessionId, (record) =>
      recordAgentSessionProviderHandle({ record, fence: event.fence, link, now: context.now() })
    )
    return true
  } catch (error) {
    logger.warn('recording the handle a started provider answered with failed', {
      scope: 'provider-started-handle',
      sessionId: event.sessionId,
      error
    })
    return false
  }
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
export async function settleStructuredAgentSessionOptionsReported(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsReportedEvent
): Promise<void> {
  const child = context.sessions.get(event.sessionId)?.child
  if (child?.phase === 'starting') {
    const readiness = context.runtimeState.startupAttempts.readiness(event.sessionId, {
      generation: event.acquisitionGeneration,
      fence: event.fence
    })
    if (!readiness || (await readiness.wait()) !== 'ready') {
      return
    }
  }
  if (event.catalogListing) {
    void saveStructuredAgentSessionStartReadbackListing(context, event, event.catalogListing)
  }
  return undefined
}
