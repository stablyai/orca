import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionHandoffDirection,
  AgentSessionHandoffAction,
  AgentSessionHandoffMode,
  AgentSessionHandoffRequest
} from '../../../shared/agent-session-wire'

export type StructuredHandoffTestRequestOptions = {
  action?: AgentSessionHandoffAction
  operationId?: string
}

export class StructuredHandoffTestRequests {
  private operations = 0

  constructor(
    private readonly now: number,
    private readonly sessionId: string,
    private readonly readFence: () => number
  ) {}

  reset(): void {
    this.operations = 0
  }

  operationId(): string {
    this.operations += 1
    return `${this.now}-${this.operations.toString(16).padStart(32, '0')}`
  }

  request(
    direction: AgentSessionHandoffDirection,
    mode: AgentSessionHandoffMode,
    options: StructuredHandoffTestRequestOptions = {}
  ): AgentSessionHandoffRequest {
    const action = options.action ?? 'start'
    const fields = { direction, mode, action }
    return {
      envelope: {
        sessionId: this.sessionId,
        clientOperationId: options.operationId ?? this.operationId(),
        expectedRuntimeFence: this.readFence(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.requestHandoff',
          sessionId: this.sessionId,
          fields
        })
      },
      ...fields
    }
  }
}
