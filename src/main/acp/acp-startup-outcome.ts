import {
  agentSessionAcquireFailure,
  agentSessionStartFailure,
  AgentSessionStartFailure,
  type AgentSessionStartAnswer
} from '../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import {
  AcpAgentError,
  AcpAgentExitedError,
  AcpFrameTooLargeError,
  AcpRpcError
} from './acp-errors'

export function temporaryAcpStartupAnswer(error: unknown): boolean {
  return (
    error instanceof AcpAgentError &&
    error.code === -32603 &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'errorName' in error.data &&
    (error.data.errorName === 'ServerUnavailable' || error.data.errorName === 'CatalogNotReady')
  )
}

/** An agent's answer, sign-in included, is final unless it declared a temporary one; a frame
 *  Orca could not read is final too. Only the process's own drained exit is unanswered: a closed
 *  connection alone may be Orca refusing what the agent wrote. */
export const acpStartupAnswer: AgentSessionStartAnswer = (cause) => {
  if (cause instanceof AcpRpcError) {
    return temporaryAcpStartupAnswer(cause) ? 'temporary' : 'final'
  }
  if (cause instanceof AcpFrameTooLargeError) {
    return 'final'
  }
  return cause instanceof AcpAgentExitedError ? 'exited' : undefined
}

export function acpStartFailure(error: unknown, exited = false): AgentSessionStartFailure {
  return agentSessionStartFailure(error, acpStartupAnswer, exited)
}

/** Orca closed the connection before the agent exited, refusing what it wrote: final. */
export function acpRefusedStart(lost: Error): AgentSessionStartFailure {
  return new AgentSessionStartFailure(lost, 'never')
}

export function acpAcquireFailure(error: unknown): unknown {
  return agentSessionAcquireFailure(error, acpStartupAnswer)
}
