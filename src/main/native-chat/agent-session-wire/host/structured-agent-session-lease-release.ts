import type { StructuredAgentSessionChildExit } from '../termination/structured-agent-session-child-exit-record'
import type { StructuredAgentSessionChildExitContext } from '../termination/structured-agent-session-child-exit'
import { evictStructuredAgentSession } from '../termination/structured-agent-session-eviction'
// Release only this host’s child with observed/proven exit; read-only or TUI ownership
// proves no exit and must never admit a second writer.

import {
  isSurfaceReleasableAgentSessionRecord,
  releaseStoredAgentSessionOwnerAfterSurfaceClose
} from '../../../runtime/agent-session/ownership/agent-session-surface-release-transition'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionEndedEvent } from '../providers/structured-agent-session-adapter'

export type StructuredAgentSessionLeaseStore = Pick<
  AgentSessionRecordStore,
  'getRecord' | 'updateRecord'
>

/** Release the observed child; throw agent_session_checkpoint_stale if ownership changed. */
export async function releaseStoredStructuredAgentSessionOwnerAfterExit(input: {
  store: StructuredAgentSessionLeaseStore
  sessionId: string
  expectedFence: number
  now: number
  deathEvidenceKind?: 'kill-delivered'
  exitObservedAt?: number
  exitReason?: string
}): Promise<AgentSessionRecord> {
  const record = input.store.getRecord(input.sessionId)
  if (
    !record ||
    record.lease.runtimeFence !== input.expectedFence ||
    !isSurfaceReleasableAgentSessionRecord(record)
  ) {
    throw new Error('agent_session_checkpoint_stale')
  }
  return releaseStoredAgentSessionOwnerAfterSurfaceClose(input.store, {
    sessionId: input.sessionId,
    expectedFence: input.expectedFence,
    now: input.now,
    ...(input.deathEvidenceKind ? { deathEvidenceKind: input.deathEvidenceKind } : {}),
    ...(input.exitObservedAt === undefined ? {} : { exitObservedAt: input.exitObservedAt }),
    ...(input.exitReason ? { exitReason: input.exitReason } : {})
  })
}

/** A late exit can refine only the same released writer's termination evidence. */
export async function upgradeStoredStructuredAgentSessionOwnerExitEvidence(
  store: StructuredAgentSessionLeaseStore,
  event: StructuredAgentSessionEndedEvent,
  now: number
): Promise<void> {
  const record = store.getRecord(event.sessionId)
  if (
    !event.deathEvidenceKind &&
    record?.lease.claimStatus === 'released' &&
    record.lease.deathEvidence?.kind === 'kill-delivered' &&
    record.lease.deathEvidence.ownerFence === event.fence
  ) {
    await store.updateRecord(event.sessionId, {
      kind: 'exit-observed',
      fence: event.fence,
      observedAt: event.observedAt ?? now
    })
  }
}

/** Release proven ownership and its sink before publishing the child as gone. */
export async function releaseExitedStructuredAgentSessionOwner(
  context: Pick<StructuredAgentSessionChildExitContext, 'store' | 'now' | 'route' | 'logger'>,
  sessionId: string,
  fence: number,
  exit: StructuredAgentSessionChildExit,
  observedAt: number
): Promise<boolean> {
  let released = false
  try {
    await releaseStoredStructuredAgentSessionOwnerAfterExit({
      store: context.store,
      sessionId,
      expectedFence: fence,
      now: context.now(),
      exitObservedAt: observedAt,
      exitReason: exit.reason,
      ...(exit.deathEvidenceKind ? { deathEvidenceKind: exit.deathEvidenceKind } : {})
    })
    released = true
  } catch (error) {
    context.logger.warn('settling a provider exit did not finish', {
      scope: 'exit-owner-release',
      sessionId,
      error
    })
  }
  if (context.route) {
    const { runtimeState, acknowledgeRelease } = context.route
    await evictStructuredAgentSession({
      sessionId,
      eventSink: runtimeState.eventSinkFor(sessionId),
      logger: context.logger,
      discardSink: () => runtimeState.discardEventSink(sessionId),
      acknowledgeRelease: () => acknowledgeRelease(sessionId)
    })
  }
  return released
}
