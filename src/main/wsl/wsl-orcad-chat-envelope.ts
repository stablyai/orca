import { randomUUID } from 'node:crypto'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'

/** The mutation envelope the lane's agentSession calls carry, as a paired client sends it. */
export function envelope(
  sessionId: string,
  method: string,
  fields: Record<string, unknown>,
  fence: number | null
) {
  return {
    sessionId,
    expectedRuntimeFence: fence,
    clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ sessionId, method, fields })
  }
}
