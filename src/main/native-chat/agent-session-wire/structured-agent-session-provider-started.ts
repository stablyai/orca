import type { StructuredAgentSessionOptionsReportedEvent } from './structured-agent-session-adapter'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  markProviderChildStarted,
  sameProviderChild
} from './structured-agent-session-provider-child'
import {
  saveStructuredAgentSessionListing,
  saveStructuredAgentSessionStartReadbackListing
} from './structured-agent-session-start-listing'
import type { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import {
  noteStructuredAgentSessionRuntimeOptions,
  noteStructuredAgentSessionReportedOptions
} from './structured-agent-session-ran-options'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { settleUnheldStructuredAgentSessionTurns } from './structured-agent-session-unheld-turns'
import { AgentSessionStartFailure } from './structured-agent-session-start-failure'
import {
  applyRewindAtStart,
  readRewindAtStart,
  recordStartedHandle,
  refusedStart,
  type OpenedProvider
} from './structured-agent-session-start-provider-answer'
import type { StructuredRewindRecoveryEvidence } from './structured-rewind-recovery'

export type StructuredAgentSessionProviderStartedContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  publishStatus?: (sessionId: string) => void
  runtimeState: {
    startupAttempts: Pick<
      StructuredAgentSessionStartupAttempts,
      'ready' | 'onClock' | 'readiness' | 'own' | 'disown' | 'failed' | 'released' | 'rootExit'
    >
    acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  }
  /** Commits the child's buffered lifecycle events. */
  flushLifecycle?: (sessionId: string) => Promise<unknown>
  /** Release startup’s delivery barrier and drain all currently handable sends. */
  wakeDelivery: (sessionId: string) => Promise<void>
}

/** A failure is the adapter's verdict on required provider work or on this child ending before it
 *  was ready, or Orca refusing what the open answered; `stale` retires only this owner. */
export type StructuredAgentSessionProviderStartedOutcome =
  | 'ready'
  | 'stale'
  | AgentSessionStartFailure

export async function settleStructuredAgentSessionProviderStarted(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider,
  signal?: AbortSignal
): Promise<StructuredAgentSessionProviderStartedOutcome> {
  // Read provider state outside serialization so sends can still be accepted.
  const rewind = await readRewindAtStart(context, event, signal)
  // Required provider work's own verdict outranks this child's later death.
  if (rewind instanceof AgentSessionStartFailure) {
    return rewind
  }
  const child = { generation: event.acquisitionGeneration, fence: event.fence }
  // Only the adapter's word on this exact acquisition says it died; absence alone says nothing.
  const ended = () =>
    context.deps.adapter.startupEnding?.(event.sessionId, event.acquisitionGeneration)
  const local: LocalSettlement = { started: false, fenced: false }
  // A death the adapter reports ends the start without waiting on its bookkeeping below, but
  // never once Orca's own handle or rewind write began: only that write's answer says whether
  // the start may run again, and the contract guard bounds the wait for it.
  const died = context.runtimeState.startupAttempts.rootExit(event.sessionId, child).then(() => {
    const ending = local.started ? undefined : ended()
    if (!ending) {
      return new Promise<never>(() => {})
    }
    local.fenced = true
    return ending
  })
  return Promise.race([died, settleReady(context, event, rewind, ended, local, signal)])
}

/** `fenced`: the death decided the start, so its local writes never begin. */
type LocalSettlement = { started: boolean; fenced: boolean }

function settleReady(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider,
  rewind: StructuredRewindRecoveryEvidence,
  ended: () => AgentSessionStartFailure | undefined,
  local: LocalSettlement,
  signal?: AbortSignal
): Promise<StructuredAgentSessionProviderStartedOutcome> {
  const child = { generation: event.acquisitionGeneration, fence: event.fence }
  // Restored history is committed and the child's own events drained before its turns are judged.
  return Promise.resolve(context.flushLifecycle?.(event.sessionId)).then(() =>
    // Follow attach publication so its proven lease has committed.
    context.serialize(event.sessionId, async () => {
      signal?.throwIfAborted()
      const session = context.sessions.get(event.sessionId)
      const ending = ended()
      const current = session?.child && sameProviderChild(session.child, child) ? session : null
      if (!current?.child) {
        return ending ?? 'stale'
      }
      // Stale or expired startup cannot lift the current child’s barrier.
      if (
        current.child.phase !== 'starting' ||
        !context.runtimeState.startupAttempts.onClock(event.sessionId, child)
      ) {
        return 'stale'
      }
      if (ending || local.fenced) {
        return ending ?? 'stale'
      }
      local.started = true
      if (
        !(await recordStartedHandle(context, event)) ||
        !(await applyRewindAtStart(context, event.sessionId, current, rewind))
      ) {
        return refusedStart()
      }
      signal?.throwIfAborted()
      // The writes succeeded; a death meanwhile is still this start's outcome.
      const endedWhileWriting = ended()
      if (endedWhileWriting) {
        return endedWhileWriting
      }
      if (
        !context.runtimeState.startupAttempts.onClock(event.sessionId, child) ||
        !markProviderChildStarted(current, child)
      ) {
        return 'stale'
      }
      await settleUnheldStructuredAgentSessionTurns(
        current.journal,
        event.sessionId,
        child.fence,
        event.acquisitionGeneration,
        context.deps.adapter.liveTurnId?.(event.sessionId)
      ).catch((error: unknown) =>
        context.deps.logger.warn('settling turns the agent is not running failed', {
          scope: 'unheld-turns',
          sessionId: event.sessionId,
          error
        })
      )
      const sourceChild = current.child
      context.runtimeState.startupAttempts.ready(event.sessionId, child)
      noteStructuredAgentSessionRuntimeOptions(current.child, event.reportedOptions, true)
      context.publishStatus?.(event.sessionId)
      await noteStructuredAgentSessionReportedOptions(
        context,
        event.sessionId,
        child.fence,
        event.reportedOptions
      )
      void context.wakeDelivery(event.sessionId)
      noteStructuredAgentSessionProviderStarted(
        context.deps,
        event.sessionId,
        () =>
          context.sessions.get(event.sessionId)?.child === sourceChild &&
          sourceChild?.catalogSource?.() !== false
      )
      if (event.catalogListing) {
        saveStructuredAgentSessionListing(
          context,
          event.sessionId,
          event.catalogListing,
          () =>
            context.sessions.get(event.sessionId)?.child === sourceChild &&
            sourceChild?.catalogSource?.() !== false
        )
      }
      context.publishStatus?.(event.sessionId)
      return 'ready' as const
    })
  )
}

/** Prompt catalog recheck after startup may prove installation or restored sign-in; the probe decides. */
export function noteStructuredAgentSessionProviderStarted(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'modelCatalog'>,
  sessionId: string,
  source?: () => boolean
): void {
  const record = deps.store.getRecord(sessionId)
  if (record) {
    deps.modelCatalog?.providerStarted(record, source)
  }
}

export async function settleStructuredAgentSessionOptionsReported(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsReportedEvent
): Promise<void> {
  const child = context.sessions.get(event.sessionId)?.child
  if (
    !child ||
    !sameProviderChild(child, { generation: event.acquisitionGeneration, fence: event.fence })
  ) {
    return
  }
  noteStructuredAgentSessionRuntimeOptions(child, event.reportedOptions)
  if (child.phase === 'starting') {
    const readiness = context.runtimeState.startupAttempts.readiness(event.sessionId, {
      generation: event.acquisitionGeneration,
      fence: event.fence
    })
    if (!readiness || (await readiness.wait()) !== 'ready') {
      return
    }
  }
  if (context.sessions.get(event.sessionId)?.child !== child) {
    return
  }
  context.publishStatus?.(event.sessionId)
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
