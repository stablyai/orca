import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'

/** Runs under the session task queue; a probe can only retire the identity it sampled. */
export async function retireProbedStructuredSessionOwner(input: {
  record: AgentSessionRecord
  probe: AgentSessionOwnerProbe
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  runtime: StructuredAgentSessionHostRuntimeState
  delivery: StructuredAgentSessionClientDelivery
  now: () => number
}): Promise<void> {
  const { sessionId, lease } = input.record
  const current = input.deps.store.getRecord(sessionId)
  const session = input.sessions.get(sessionId)
  if (
    !session ||
    current?.lease.runtimeFence !== lease.runtimeFence ||
    JSON.stringify(current.lease.ownerProcess) !== JSON.stringify(lease.ownerProcess)
  ) {
    return
  }
  session.hasProviderChild = false
  input.delivery.publishStatus(sessionId)
  await input.runtime.lifecycleBarrier(sessionId)
  input.runtime.eventSinkFor(sessionId).unbind()
  const released = await input.deps.store.evictProvenDeadOwner({
    sessionId,
    expectedFence: lease.runtimeFence,
    probe: input.probe,
    now: input.now()
  })
  input.deps.adapter.acknowledgeSessionRelease?.(sessionId)
  session.fence = released.lease.runtimeFence
  await retryPendingStructuredAgentSessionSettlement({
    deps: input.deps,
    sessions: input.sessions,
    sessionId,
    params: session.params,
    now: input.now,
    onCompleted: input.delivery.completeSettlement
  })
  input.delivery.publishStatus(sessionId)
}

export async function refreshRecoverableStructuredSession(
  input: Omit<Parameters<typeof retireProbedStructuredSessionOwner>[0], 'probe'>
): Promise<void> {
  const { sessionId, lease } = input.record
  const session = input.sessions.get(sessionId)
  if (
    !session ||
    input.deps.store.getRecord(sessionId)?.lease.runtimeFence !== lease.runtimeFence
  ) {
    return
  }
  await input.runtime.resolveRecovery(sessionId)
  await retryPendingStructuredAgentSessionSettlement({
    deps: input.deps,
    sessions: input.sessions,
    sessionId,
    params: session.params,
    now: input.now,
    onCompleted: input.delivery.completeSettlement
  })
  input.delivery.publishStatus(sessionId)
}
