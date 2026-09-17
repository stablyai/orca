import {
  parseAgentExecutionObservation,
  type AgentExecutionAttachment,
  type AgentExecutionObservation
} from '../../../shared/agent-execution-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  admitLegacyAgentStatus,
  type HookListenerState
} from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'
import type {
  AgentHookStatusFreshnessObservation,
  EnrichedAgentHookEventPayload
} from './server-types'

type PublishExecutionObservationArgs = {
  paneKey: string
  observation: AgentExecutionObservation
  attachment?: AgentExecutionAttachment
  state: HookListenerState
  runtimeObservedStatusPaneKeys: ReadonlySet<string>
  commitStatusRowMutation: (
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined
  ) => boolean
  emitEnrichedStatus: (entry: EnrichedAgentHookEventPayload) => void
  emitStatusFreshnessObservation: (status: AgentHookStatusFreshnessObservation) => void
}

function isEnrichedStatusRow(
  value: AgentHookEventPayload | undefined
): value is EnrichedAgentHookEventPayload {
  return (
    value !== undefined &&
    typeof value === 'object' &&
    'receivedAt' in value &&
    typeof value.receivedAt === 'number' &&
    'stateStartedAt' in value &&
    typeof value.stateStartedAt === 'number'
  )
}

export function publishExecutionObservationIntoStore({
  paneKey,
  observation,
  attachment,
  state,
  runtimeObservedStatusPaneKeys,
  commitStatusRowMutation,
  emitEnrichedStatus,
  emitStatusFreshnessObservation
}: PublishExecutionObservationArgs): boolean {
  const parsedObservation = parseAgentExecutionObservation(observation)
  if (!parsedObservation) {
    return false
  }
  const current = state.lastStatusByPaneKey.get(paneKey)
  if (!isEnrichedStatusRow(current)) {
    return false
  }
  const currentExecutionId =
    'executionId' in current && typeof current.executionId === 'string'
      ? current.executionId
      : undefined
  const currentRunId =
    'runId' in current && typeof current.runId === 'string' ? current.runId : undefined
  if (
    (currentExecutionId !== undefined && currentExecutionId !== parsedObservation.executionId) ||
    (currentRunId !== undefined && currentRunId !== parsedObservation.runId)
  ) {
    return false
  }
  const previous = current.executionObservation
  const hasExactAttachmentProof =
    attachment?.paneKey === paneKey &&
    attachment.executionId === parsedObservation.executionId &&
    attachment.hostId === parsedObservation.hostId &&
    attachment.hostEpoch === parsedObservation.hostEpoch &&
    attachment.runId === parsedObservation.runId &&
    attachment.role === parsedObservation.role &&
    attachment.continuityOf === parsedObservation.continuityOf
  const sameObservationAttachment =
    previous?.executionId === parsedObservation.executionId &&
    previous.hostEpoch === parsedObservation.hostEpoch &&
    previous.hostId === parsedObservation.hostId &&
    previous.runId === parsedObservation.runId &&
    previous.role === parsedObservation.role &&
    previous.continuityOf === parsedObservation.continuityOf
  if (
    previous &&
    ((!sameObservationAttachment && !hasExactAttachmentProof) ||
      (sameObservationAttachment && previous.captureRevision >= parsedObservation.captureRevision))
  ) {
    return false
  }
  const enriched: EnrichedAgentHookEventPayload = {
    ...current,
    executionObservation: parsedObservation
  }
  if (
    !admitLegacyAgentStatus(
      state,
      'main-execution-observation',
      enriched,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  ) {
    return false
  }
  commitStatusRowMutation(current, enriched)
  emitEnrichedStatus(enriched)
  emitStatusFreshnessObservation({
    paneKey,
    state: enriched.payload.state,
    receivedAt: enriched.receivedAt,
    observedInCurrentRuntime: runtimeObservedStatusPaneKeys.has(paneKey),
    ...(enriched.worktreeId ? { worktreeId: enriched.worktreeId } : {}),
    ...(enriched.terminalHandle ? { terminalHandle: enriched.terminalHandle } : {})
  })
  return true
}
