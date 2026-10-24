// Keep close state on the exact child. Callers join adapter-bounded attempts and retry unproven exits;
// root-exit proof reaches the single exit handler, including late adapter reports.

import { refuse } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import { releaseStoredStructuredAgentSessionOwnerAfterExit } from './structured-agent-session-lease-release'
import { isSurfaceReleasableAgentSessionRecord } from '../../runtime/agent-session-surface-release-transition'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'

/** A surviving root after kill remains unverifiable, never exited. */
export type StructuredAgentSessionChildCloseVerdict = 'exited' | 'unverifiable'

export async function joinStructuredAgentSessionChildClose(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  child: StructuredAgentSessionProviderChild
): Promise<StructuredAgentSessionChildCloseVerdict> {
  // Capture startup state before provider release loses that evidence.
  const unanswered = child.phase === 'starting'
  if (!(await closeProviderRoot(context, sessionId))) {
    return 'unverifiable'
  }
  await endClosedStructuredAgentSessionChild(context, sessionId, child, unanswered)
  return 'exited'
}

async function endClosedStructuredAgentSessionChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  child: StructuredAgentSessionProviderChild,
  unanswered: boolean
): Promise<void> {
  await context.endExitedChild(sessionId, child, {
    expected: true,
    reason: 'closed by Orca',
    ...(child.close?.failure ? { failure: child.close.failure } : {}),
    ...(unanswered ? { startupUnanswered: true } : {})
  })
  context.restartWitness?.stopped(sessionId)
}

export function previousExitUnverifiableRefusal(): AgentSessionWireRefusal {
  return refuse(
    'agent_session_ownership_unknown',
    { reason: 'previousExitUnverifiable', ownerVerdict: 'unverifiable' },
    "Orca could not prove this chat's previous agent process exited."
  )
}

/** Closing children take no input; join close before provider work, refusing unproven exit.
 * Background starts wait outside serialization and finalize only the same child under it. */
export async function joinClosingStructuredAgentSessionChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  lock?: StructuredAgentSessionAttachLock
): Promise<{ ok: true } | { ok: false; refusal: AgentSessionWireRefusal }> {
  const child = context.sessions.get(sessionId)?.child
  if (!child?.close) {
    return { ok: true }
  }
  const unanswered = child.phase === 'starting'
  const closing = closeProviderRoot(context, sessionId)
  if (await (lock ? lock.wait(closing) : closing)) {
    const end = () => endClosedStructuredAgentSessionChild(context, sessionId, child, unanswered)
    await (lock
      ? lock.commit(async () => {
          if (context.sessions.get(sessionId)?.child === child) {
            await end()
          }
        })
      : end())
    return { ok: true }
  }
  // This refusal is the only visible trace outside Stop’s own failure path.
  context.deps.logger.warn("the agent's process did not exit after Orca stopped and killed it", {
    scope: 'provider-close-unproven',
    sessionId
  })
  return { ok: false, refusal: previousExitUnverifiableRefusal() }
}

function closeProviderRoot(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<boolean> {
  const { adapter, logger } = context.deps
  // Missing close means no owned process; implemented closes must prove exit.
  const stop = adapter.disposeSession ?? adapter.closeSession
  if (!stop) {
    return Promise.resolve(true)
  }
  return stopAgentSessionProviderRoot(
    () => stop.call(adapter, sessionId),
    // Proven exit stands; descendant/follow-up failures are log-only.
    (error) =>
      logger.warn("the agent's process exited, but its close did not finish cleanly", {
        scope: 'provider-close-after-exit',
        sessionId,
        error
      })
  ).catch((error: unknown) => {
    logger.warn("closing the agent's process did not prove it exited", {
      scope: 'provider-close',
      sessionId,
      error
    })
    return false
  })
}

/** Retain the handle while its first-hand exit proof is needed to release the matching lease. */
export function structuredAgentSessionEndedChildHoldsLease(
  context: Pick<StructuredAgentSessionLifetimeContext, 'deps' | 'sessions'>,
  sessionId: string
): boolean {
  const ended = context.sessions.get(sessionId)?.lastEndedChild
  const record = context.deps.store.getRecord(sessionId)
  return (
    ended?.rootGone === true &&
    record !== null &&
    isSurfaceReleasableAgentSessionRecord(record) &&
    record.lease.runtimeFence === ended.fence
  )
}

/** Retry durable release from retained exit proof; report failures and return whether the lease still matches. */
export async function releaseLeaseOfEndedStructuredAgentSessionChild(
  context: Pick<StructuredAgentSessionLifetimeContext, 'deps' | 'sessions' | 'now'>,
  sessionId: string
): Promise<boolean> {
  const ended = context.sessions.get(sessionId)?.lastEndedChild
  if (!ended || !structuredAgentSessionEndedChildHoldsLease(context, sessionId)) {
    return false
  }
  await releaseStoredStructuredAgentSessionOwnerAfterExit({
    store: context.deps.store,
    sessionId,
    expectedFence: ended.fence,
    now: context.now(),
    ...(ended.reason ? { exitReason: ended.reason } : {})
  }).catch((error: unknown) =>
    context.deps.logger.warn("releasing an exited agent's lease failed", {
      scope: 'ended-child-lease-release',
      sessionId,
      error
    })
  )
  return structuredAgentSessionEndedChildHoldsLease(context, sessionId)
}
