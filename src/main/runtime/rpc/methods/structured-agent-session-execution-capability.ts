import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_EXECUTION_VIEW_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

/** Older clients retain their journal-only projection; they cannot display verification. */
export function projectExecutionStatusEvent(
  event: AgentSessionStatusEvent,
  ctx: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): AgentSessionStatusEvent {
  if (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_EXECUTION_VIEW_CAPABILITY)
  ) {
    return event
  }
  const legacy = (summary: AgentSessionStatusSummary): AgentSessionStatusSummary => {
    const { execution, ...rest } = summary
    return execution ? { ...rest, status: execution.historicalStatus } : summary
  }
  return event.type === 'snapshot'
    ? { ...event, sessions: event.sessions.map(legacy) }
    : event.type === 'status'
      ? { ...event, session: legacy(event.session) }
      : event
}
