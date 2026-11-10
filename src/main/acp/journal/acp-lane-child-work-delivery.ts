import type { StructuredAgentSessionChildWorkProducer } from '../../native-chat/agent-session-wire/observations/structured-agent-session-subagent-rows'
import type { AcpStructuredSessionAdapterDeps } from '../session/acp-structured-session-adapter-deps'
import type { AcpStructuredLaneDeps } from './acp-structured-lane'

export function acpLaneChildWorkDelivery(
  deps: AcpStructuredSessionAdapterDeps,
  sessionId: string,
  producer?: StructuredAgentSessionChildWorkProducer
): Pick<AcpStructuredLaneDeps, 'onChildWorkEvidence' | 'onChildWorkFailure'> {
  return {
    onChildWorkEvidence: (evidence) => deps.onChildWorkEvidence?.(sessionId, evidence, producer),
    onChildWorkFailure: (error) =>
      deps.logger?.error('publishing ACP child work failed', {
        scope: 'acp-child-work',
        sessionId,
        error
      })
  }
}
