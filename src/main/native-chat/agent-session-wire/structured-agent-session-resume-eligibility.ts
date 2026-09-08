// When a record may be handed back a provider child.
//
// This used to be inline in the restart restore, which is what made it a STARTUP rule: every record
// whose lease looked like this got a child, at launch, whether or not anything was going to look at
// it. `released` + no handoff is the normal end state of a chat the user closed cleanly, so a
// healthy profile respawned everything it had ever opened. The predicate itself was never wrong —
// it answers "may this be resumed", not "should it be" — so it lives here now and the caller that
// knows a surface is asking is the only one that acts on it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { randomUUID } from 'node:crypto'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-read-restore'

export function isResumableStructuredAgentSessionRecord(record: AgentSessionRecord): boolean {
  return (
    !record.lease.unreconciled &&
    record.lease.claimStatus === 'released' &&
    record.lease.handoffStage === null
  )
}

/** Attach params for a resume, or null when this record's lease is somebody else's problem. */
export function structuredAgentSessionResumeParams(
  record: AgentSessionRecord,
  clientOperationId: string
): AgentSessionAttachParams | null {
  if (!isResumableStructuredAgentSessionRecord(record)) {
    return null
  }
  return attachParamsForRecord(record, {
    clientOperationId,
    expectedRuntimeFence: record.lease.runtimeFence,
    runtimeKind: 'native'
  })
}

/** `<13-digit ms>-<32 hex>`, the only operation-id shape the durable ledger admits. */
export function structuredAgentSessionResumeOperationId(now: number): string {
  return `${Math.trunc(now).toString().padStart(13, '0')}-${randomUUID().replaceAll('-', '')}`
}
