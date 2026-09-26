// Handing the durable lease back after this host stopped its child: released when the stop proved
// the root gone, handed to recovery when it could not.
//
// Guarded on `hasProviderChild` for a reason that is not bookkeeping: a session restored only for
// reading, or one a TUI owns, names an owner process this host never started and may still be
// alive. Writing `exit-observed` against that record would release a lease out from under a running
// process and let a second writer in.

import {
  isSurfaceReleasableAgentSessionRecord,
  recoverAgentSessionOwnerAfterUnprovenStop,
  releaseStoredAgentSessionOwnerAfterSurfaceClose
} from '../../runtime/agent-session-surface-release-transition'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAgentSessionLeaseStore = Pick<
  AgentSessionRecordStore,
  'getRecord' | 'transitionHandoff'
>

export async function releaseStoredStructuredAgentSessionOwner(input: {
  store: StructuredAgentSessionLeaseStore
  sessionId: string
  hasProviderChild: boolean
  expectedFence: number
  now: number
  /** The stop's verdict, from `stopAgentSessionProviderRoot`: the only thing this decides. */
  rootGone: boolean
  /** Why the child stopped, when the host knows more than that it did. */
  reason?: string
}): Promise<void> {
  if (!input.hasProviderChild) {
    return
  }
  const record = input.store.getRecord(input.sessionId)
  if (
    !record ||
    record.lease.runtimeFence !== input.expectedFence ||
    !isSurfaceReleasableAgentSessionRecord(record)
  ) {
    return
  }
  if (!input.rootGone) {
    await input.store.transitionHandoff(input.sessionId, (latest) =>
      recoverAgentSessionOwnerAfterUnprovenStop({
        record: latest,
        expectedFence: input.expectedFence,
        now: input.now
      })
    )
    return
  }
  await releaseStoredAgentSessionOwnerAfterSurfaceClose(input.store, {
    sessionId: input.sessionId,
    expectedFence: input.expectedFence,
    now: input.now,
    ...(input.reason ? { exitReason: input.reason } : {})
  })
}

/** Releases only the exact provider child whose exit the adapter positively observed. */
export async function releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit(input: {
  store: StructuredAgentSessionLeaseStore
  sessionId: string
  expectedFence: number
  expectedAcquisitionGeneration: string
  acquisitionGeneration: string | null
  now: number
  exitObservedAt?: number
  exitReason?: string
}): Promise<AgentSessionRecord> {
  if (input.acquisitionGeneration !== input.expectedAcquisitionGeneration) {
    throw new Error('agent_session_checkpoint_stale')
  }
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
    exitObservedAt: input.exitObservedAt,
    ...(input.exitReason ? { exitReason: input.exitReason } : {})
  })
}
