import {
  agentSessionAcquireFailure,
  agentSessionStartFailure,
  type AgentSessionStartAnswer,
  type AgentSessionStartFailure
} from '../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { JsonlRpcAgentExitError } from '../jsonl-rpc/agent-connection'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'

/** Pi declares no temporary startup answers. Only its process's own exit, once its output
 *  drained, leaves a start unanswered; a closed stream alone proves no exit. */
export const piStartupAnswer: AgentSessionStartAnswer = (cause) => {
  if (cause instanceof JsonlRpcResponseError) {
    return 'final'
  }
  return cause instanceof JsonlRpcAgentExitError ? 'exited' : undefined
}

export function piStartFailure(error: unknown, exited = false): AgentSessionStartFailure {
  return agentSessionStartFailure(error, piStartupAnswer, exited)
}

export function piAcquireFailure(error: unknown): unknown {
  return agentSessionAcquireFailure(error, piStartupAnswer)
}
