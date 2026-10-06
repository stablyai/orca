// A provider child's close, which every stop, start and provider write that meets it joins.
//
// The close lives on the child (`child.close`) and ends with it, so nothing outlives the process
// it is about. Joining it is asking the adapter to close: the adapter runs one close per child at
// a time and bounds it by its own kill escalation, so every caller waits on the same attempt, and
// a caller that comes after an attempt ended unproven runs it again. The verdict is the root's
// exit alone. Proven, the one exit handler ends the record; a proof that lands with no caller
// waiting reaches that handler as the adapter's report of the exit.

import { refuse } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'
import { releaseStoredStructuredAgentSessionOwnerAfterExit } from './structured-agent-session-lease-release'
import { isSurfaceReleasableAgentSessionRecord } from '../../runtime/agent-session-surface-release-transition'

/** What a caller learned about the child's exit: proven, or not. A root still there after the
 *  close's kill reads `unverifiable`, never `exited`. */
export type StructuredAgentSessionChildCloseVerdict = 'exited' | 'unverifiable'

/** Joins the child's close and, once its root's exit is proven, ends the record. */
export async function joinStructuredAgentSessionChildClose(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  child: StructuredAgentSessionProviderChild
): Promise<StructuredAgentSessionChildCloseVerdict> {
  if (!(await closeProviderRoot(context, sessionId))) {
    return 'unverifiable'
  }
  await context.endExitedChild(sessionId, child, { expected: true, reason: 'closed by Orca' })
  context.restartWitness?.stopped(sessionId)
  return 'exited'
}

/** The refusal of an operation that met a child whose close is still unproven. */
export function previousExitUnverifiableRefusal(): AgentSessionWireRefusal {
  return refuse(
    'agent_session_ownership_unknown',
    { reason: 'previousExitUnverifiable', ownerVerdict: 'unverifiable' },
    "Orca could not prove this chat's previous agent process exited."
  )
}

/** For an operation that reaches the provider: a child a stop began closing takes no input and
 *  none may start beside it, so the operation joins that close and is refused while it is still
 *  unproven. */
export async function joinClosingStructuredAgentSessionChild(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<{ ok: true } | { ok: false; refusal: AgentSessionWireRefusal }> {
  const child = context.sessions.get(sessionId)?.child
  if (!child?.close) {
    return { ok: true }
  }
  if ((await joinStructuredAgentSessionChildClose(context, sessionId, child)) === 'exited') {
    return { ok: true }
  }
  // A stop reports this through its own failure; here the refusal is the only trace.
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
  // An adapter with no close has nothing to stop; anything else must PROVE the exit.
  const stop = adapter.disposeSession ?? adapter.closeSession
  if (!stop) {
    return Promise.resolve(true)
  }
  return stopAgentSessionProviderRoot(
    () => stop.call(adapter, sessionId),
    // The exit is proven; a child process left behind, or a write after it, is reported only.
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

/** Whether the lease still names the child this host last proved gone, unreleased: only that
 *  in-memory proof lets this host release it without a probe, so the handle carrying it stays. */
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

/** Writes the release a proven exit allows when the exit handler could not: a start and the
 *  handle's close re-derive it, and a failure is reported, never anyone's refusal. Resolves
 *  whether the lease still names that child. */
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
