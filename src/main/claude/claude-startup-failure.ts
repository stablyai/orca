import { findInErrorChain } from '../provider-process/provider-error-chain'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import {
  agentSessionAcquireFailure,
  agentSessionStartFailure,
  providerResourcePressure,
  type AgentSessionStartAnswer,
  type AgentSessionStartFailure
} from '../native-chat/agent-session-wire/structured-agent-session-start-failure'

/** SDK runtime tags are not in its public Error declaration. */
export function claudeStartupErrorClass(error: Error): string | undefined {
  return 'errorClass' in error && typeof error.errorClass === 'string'
    ? error.errorClass
    : undefined
}

/** The SDK's tag reports whether Claude's process ended unanswered; every other tag is its answer.
 *  A launch the host could not run for want of resources is left to the shared rule. */
export const claudeStartupAnswer: AgentSessionStartAnswer = (error) => {
  const tag =
    claudeStartupErrorClass(error) ??
    (error instanceof ClaudeControlRequestError
      ? (findInErrorChain(error.cause, (cause) => claudeStartupErrorClass(cause)) ?? 'answered')
      : undefined)
  if (tag === undefined) {
    return undefined
  }
  if (tag === 'process_exited_nonzero' || tag === 'process_killed_by_signal') {
    return 'reported'
  }
  if (tag === 'executable_launch_failed' || tag === 'spawn_failed' || tag === 'process_error') {
    return providerResourcePressure(error) ? undefined : 'final'
  }
  return 'final'
}

export function claudeStartFailure(error: unknown): AgentSessionStartFailure {
  return agentSessionStartFailure(error, claudeStartupAnswer)
}

export function claudeAcquireFailure(error: unknown): unknown {
  return agentSessionAcquireFailure(error, claudeStartupAnswer)
}
