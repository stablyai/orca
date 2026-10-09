import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

export function readMobileStructuredOptions(args: {
  client: RpcClient
  sessionId: string
  generation: { current: number }
  isCurrent: () => boolean
  /** Every answer, even one a newer read or reset superseded. */
  onAnswer?: (result: AgentSessionOptionsResult) => void
  onResult: (result: AgentSessionOptionsResult) => void
}): void {
  const sequence = ++args.generation.current
  void callAgentSession<AgentSessionOptionsResult>(args.client, 'agentSession.options', {
    sessionId: args.sessionId
  })
    .then((result) => {
      args.onAnswer?.(result)
      if (args.isCurrent() && args.generation.current === sequence) {
        args.onResult(result)
      }
    })
    .catch(() => undefined)
}
