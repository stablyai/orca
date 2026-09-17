import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../../../shared/agent-session-host-authority'
import {
  parseAgentStatusLaunchBinding,
  type AgentStatusLaunchBinding
} from '../../../shared/agent-status-launch-membership'
import type { EnrichedAgentHookEventPayload } from './server-types'

export function ownerStatusBinding(value: unknown): AgentStatusLaunchBinding | null {
  if (!isAgentSessionOwnerBinding(value)) {
    return null
  }
  return parseAgentStatusLaunchBinding(value.statusBinding)
}

export function launchMembershipKey(binding: AgentStatusLaunchBinding): string {
  return `${binding.runId}\u0000${binding.attachment.executionId}`
}

export function readEnrichedStatus(
  value: AgentHookEventPayload | undefined
): EnrichedAgentHookEventPayload | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('receivedAt' in value) ||
    typeof value.receivedAt !== 'number' ||
    !('stateStartedAt' in value) ||
    typeof value.stateStartedAt !== 'number'
  ) {
    return undefined
  }
  return { ...value, receivedAt: value.receivedAt, stateStartedAt: value.stateStartedAt }
}

export function isOwnerBinding(value: unknown): value is AgentSessionOwnerBinding {
  return isAgentSessionOwnerBinding(value)
}
