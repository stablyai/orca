import type {
  AgentSessionRewindRecord,
  AgentSessionRewindResult
} from '../../../shared/agent-session-rewind'

export function completedStructuredRewind(
  prior: AgentSessionRewindRecord | undefined,
  callerKey: string,
  operationId: string
): AgentSessionRewindResult | null {
  return prior?.operationId === operationId &&
    prior.callerKey === callerKey &&
    prior.phase === 'completed' &&
    prior.epoch
    ? {
        itemId: prior.itemId,
        epoch: prior.epoch,
        ...(prior.sequence !== undefined ? { sequence: prior.sequence } : {})
      }
    : null
}
