// Release only this host’s child with observed/proven exit; read-only or TUI ownership
// proves no exit and must never admit a second writer.

import {
  isSurfaceReleasableAgentSessionRecord,
  releaseStoredAgentSessionOwnerAfterSurfaceClose
} from '../../runtime/agent-session/ownership/agent-session-surface-release-transition'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionEndedEvent } from './structured-agent-session-adapter'

export type StructuredAgentSessionLeaseStore = Pick<
  AgentSessionRecordStore,
  'getRecord' | 'transitionHandoff'
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
    await store.transitionHandoff(event.sessionId, (current) => {
      if (
        current.lease.claimStatus !== 'released' ||
        current.lease.deathEvidence?.kind !== 'kill-delivered' ||
        current.lease.deathEvidence.ownerFence !== event.fence
      ) {
        return current
      }
      return {
        ...current,
        lease: {
          ...current.lease,
          deathEvidence: {
            ...current.lease.deathEvidence,
            kind: 'exit-observed',
            observedAt: event.observedAt ?? now
          }
        }
      }
    })
  }
}
