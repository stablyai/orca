import type {
  AgentSessionHandoffRequest,
  AgentSessionHandoffStatus
} from '../../../shared/agent-session-wire'
import {
  beginStructuredManualRecovery,
  structuredManualRecoveryIsAdmissible
} from './structured-agent-session-manual-recovery'
import type { StructuredAgentSessionHandoffDeps } from './structured-agent-session-handoff-types'
import type { StructuredAgentSessionHandoffOperationGuard } from './structured-agent-session-handoff-operation-guard'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export async function requestStructuredManualRecovery(input: {
  deps: StructuredAgentSessionHandoffDeps
  operationGuard: StructuredAgentSessionHandoffOperationGuard
  callerKey: string
  params: AgentSessionHandoffRequest
  fingerprint: string
  record: AgentSessionRecord
  status: AgentSessionHandoffStatus
  requireRecord: (sessionId: string) => AgentSessionRecord
  restore: (sessionId: string) => Promise<void>
  setStatus: (sessionId: string, status: AgentSessionHandoffStatus) => void
}): Promise<boolean> {
  if (!structuredManualRecoveryIsAdmissible(input.record, input.status)) {
    return false
  }
  beginStructuredManualRecovery(input)
  return true
}
