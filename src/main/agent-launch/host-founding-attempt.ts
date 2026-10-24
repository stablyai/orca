import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { JournalTransactionObservation } from '../native-chat/agent-session-journal/journal-database'
import type { JournalSubmissionRow } from '../native-chat/agent-session-journal/journal-row-schema'
import type { AgentLaunchStructuredSurface } from './agent-launch-surface-factories'
import { AgentLaunchCancelledError } from '../../shared/agent-launch-cancellation'

/** Facts of this execution, never an instruction to reopen or resend. */
export type HostFoundingAttempt = {
  cancellation?: { controller: AbortController; requested: boolean; retain: boolean }
  terminalDispatched?: true
  terminalAdmitted?: true
  createdWorktreeId?: string
  identity?: {
    callerKey: string
    operationId: string
    fingerprint: string
    sessionId: string
    priorRecord: boolean
  }
  disposition?: 'fresh' | 'replay'
  opening?: { transaction: JournalTransactionObservation; row?: JournalSubmissionRow }
  blank?: JournalTransactionObservation
  adopted?: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    fence: number
    tabId?: string
  }
  publication?: { workspaceId: string; sessionId: string }
  /** Final synchronous admission check, inside the opening or standalone blank transaction. */
  beforeWrite?: () => void
}

export function assertHostFoundingNotCancelled(attempt: HostFoundingAttempt): void {
  if (attempt.cancellation?.requested) {
    throw new AgentLaunchCancelledError()
  }
}

export function hostFoundingAdmission(attempt: HostFoundingAttempt): {
  surfaceAdmitted?: true
  messageId?: string
} {
  const opening = attempt.opening
  return {
    ...(attempt.blank?.disposition === 'committed' ||
    opening?.transaction.disposition === 'committed' ||
    attempt.terminalAdmitted
      ? { surfaceAdmitted: true as const }
      : {}),
    ...(opening?.transaction.disposition === 'committed' && opening.row
      ? { messageId: opening.row.clientMessageId }
      : {})
  }
}

export class AgentLaunchFoundingIncompleteError extends Error {
  constructor(
    cause: unknown,
    readonly surface?: AgentLaunchStructuredSurface
  ) {
    super('agent_session_operation_unknown', { cause })
  }
}
