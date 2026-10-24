import type { StructuredAgentSessionOptionsReportedEvent } from './structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from './structured-agent-session-provider-open-contract'
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
import { noteStructuredAgentSessionReportedOptions } from './structured-agent-session-ran-options'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { recordAgentSessionProviderHandle } from '../../runtime/agent-session-provider-handle-transition'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  applyStructuredRewindRecovery,
  readStructuredRewindRecovery,
  type StructuredRewindRecoveryEvidence
} from './structured-rewind-recovery'

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
  /** Release startup’s delivery barrier and drain all currently handable sends. */
  wakeDelivery: (sessionId: string) => Promise<void>
  stopStartingChild: (sessionId: string, child: StructuredAgentSessionProviderChildIdentity) => void
}

type OpenedProvider = StructuredAgentSessionProviderOpenResult & {
  sessionId: string
  fence: number
  acquisitionGeneration: string
}

export async function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider,
  signal?: AbortSignal
): Promise<void> {
  // Read provider state outside serialization so sends can still be accepted.
  const rewind = await readRewindAtStart(context, event, signal)
  // Follow attach publication so its proven lease has committed.
  await context.serialize(event.sessionId, async () => {
    signal?.throwIfAborted()
    const session = context.sessions.get(event.sessionId)
    const child = { generation: event.acquisitionGeneration, fence: event.fence }
    // Stale or expired startup cannot lift the current child’s barrier.
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
    if (!(await applyRewindAtStart(context, event.sessionId, session, rewind))) {
      context.stopStartingChild(event.sessionId, child)
      return null
    }
    if (
      !context.runtimeState.startupAttempts.onClock(event.sessionId, child) ||
      !markProviderChildStarted(session, child)
    ) {
      return null
    }
    context.runtimeState.startupAttempts.ready(event.sessionId, child)
    await noteStructuredAgentSessionReportedOptions(
      context,
      event.sessionId,
      child.fence,
      event.reportedOptions
    )
    void context.wakeDelivery(event.sessionId)
    noteStructuredAgentSessionProviderStarted(context.deps, event.sessionId)
    if (event.catalogListing) {
      saveStructuredAgentSessionListing(context, event.sessionId, event.catalogListing)
    }
    context.publishStatus?.(event.sessionId)
    return undefined
  })
}

/** Reconcile uncertain rewind before delivery; persistent uncertainty fails startup. */
async function readRewindAtStart(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider,
  signal?: AbortSignal
): Promise<StructuredRewindRecoveryEvidence | 'failed'> {
  const { sessionId } = event
  const journal = context.sessions.get(sessionId)?.journal
  if (!journal) {
    return null
  }
  try {
    return await readStructuredRewindRecovery(
      context.deps,
      sessionId,
      journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      context.deps.adapter,
      signal,
      recordWithStartedHandle(context, event)
    )
  } catch (error) {
    return rewindRecoveryFailed(context, sessionId, error, signal)
  }
}

/** Predict the committed handle for rewind cuts; if recording is refused, retain the existing record. */
function recordWithStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  { sessionId, fence, link }: OpenedProvider
): AgentSessionRecord | null {
  const record = context.deps.store.getRecord(sessionId)
  try {
    return record && link
      ? recordAgentSessionProviderHandle({ record, fence, link, now: context.now() })
      : record
  } catch {
    return record
  }
}

async function applyRewindAtStart(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  evidence: StructuredRewindRecoveryEvidence | 'failed'
): Promise<boolean> {
  if (evidence === 'failed') {
    return false
  }
  try {
    await applyStructuredRewindRecovery(
      context.deps,
      sessionId,
      session.journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      evidence
    )
    return true
  } catch (error) {
    rewindRecoveryFailed(context, sessionId, error)
    return false
  }
}

function rewindRecoveryFailed(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  error: unknown,
  signal?: AbortSignal
): 'failed' {
  if (!signal?.aborted) {
    context.deps.logger.warn('settling a rewind in doubt at the start failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
  }
  return 'failed'
}

/** Persist the opened handle before delivery so future starts can resume; false if no handle is proven. */
async function recordStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider
): Promise<boolean> {
  const { store, logger } = context.deps
  const { link } = event
  if (!link) {
    // Only an already-proven handle permits open without a new link.
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

/** Prompt catalog recheck after startup may prove installation or restored sign-in; the probe decides. */
export function noteStructuredAgentSessionProviderStarted(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string
): void {
  const record = deps.store.getRecord(sessionId)
  if (record) {
    deps.modelCatalog?.providerStarted(record)
  }
}

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
  await noteStructuredAgentSessionReportedOptions(
    context,
    event.sessionId,
    event.fence,
    event.reportedOptions
  )
  if (event.catalogListing) {
    void saveStructuredAgentSessionStartReadbackListing(context, event, event.catalogListing)
  }
  return undefined
}
