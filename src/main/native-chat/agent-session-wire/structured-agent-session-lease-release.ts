// Handing the durable lease back after eviction stopped this host's child.
//
// Guarded on `hasProviderChild` for a reason that is not bookkeeping: a session restored only for
// reading, or one a TUI owns, names an owner process this host never started and may still be
// alive. Writing `exit-observed` against that record would release a lease out from under a running
// process and let a second writer in.

import {
  isSurfaceReleasableAgentSessionRecord,
  releaseStoredAgentSessionOwnerAfterSurfaceClose
} from '../../runtime/agent-session-surface-release-transition'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export async function releaseStoredStructuredAgentSessionOwner(input: {
  store: AgentSessionRecordStore
  sessionId: string
  hasProviderChild: boolean
  now: number
}): Promise<void> {
  if (!input.hasProviderChild) {
    return
  }
  const record = input.store.getRecord(input.sessionId)
  if (!record || !isSurfaceReleasableAgentSessionRecord(record)) {
    return
  }
  await releaseStoredAgentSessionOwnerAfterSurfaceClose(input.store, {
    sessionId: input.sessionId,
    expectedFence: record.lease.runtimeFence,
    now: input.now
  })
}

/** Releases only the exact provider child whose exit the adapter positively observed. */
export async function releaseStoredStructuredAgentSessionOwnerAfterUnexpectedExit(input: {
  store: AgentSessionRecordStore
  sessionId: string
  expectedFence: number
  expectedAcquisitionGeneration: string
  acquisitionGeneration: string | null
  now: number
  settlementRetry?: { settlementId: string; detail: string }
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
    ...(input.settlementRetry ? { settlementRetry: input.settlementRetry } : {})
  })
}
