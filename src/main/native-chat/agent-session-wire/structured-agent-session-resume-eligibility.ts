// Eligibility permits requested startup; a released saved record alone must never trigger automatic respawn.

import { agentSessionLeaseIsReleased } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { randomUUID } from 'node:crypto'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionEndedChild } from './structured-agent-session-host-types'
import { isSurfaceReleasableAgentSessionRecord } from '../../runtime/agent-session-surface-release-transition'

/** Allow matching observed-ended children despite failed release; acquisition still requires death proof. */
export function isResumableStructuredAgentSessionRecord(
  record: AgentSessionRecord,
  ended?: Pick<StructuredAgentSessionEndedChild, 'fence' | 'rootGone'>
): boolean {
  return (
    agentSessionLeaseIsReleased(record.lease) ||
    (ended?.rootGone === true &&
      ended.fence === record.lease.runtimeFence &&
      isSurfaceReleasableAgentSessionRecord(record))
  )
}

export function structuredAgentSessionResumeParams(
  record: AgentSessionRecord,
  clientOperationId: string,
  ended?: Pick<StructuredAgentSessionEndedChild, 'fence' | 'rootGone'>
): AgentSessionAttachParams | null {
  if (!isResumableStructuredAgentSessionRecord(record, ended)) {
    return null
  }
  return attachParamsForRecord(record, {
    clientOperationId,
    expectedRuntimeFence: record.lease.runtimeFence
  })
}

/** Match durable-ledger operation-ID shape. */
export function structuredAgentSessionResumeOperationId(now: number): string {
  return `${Math.trunc(now).toString().padStart(13, '0')}-${randomUUID().replaceAll('-', '')}`
}
