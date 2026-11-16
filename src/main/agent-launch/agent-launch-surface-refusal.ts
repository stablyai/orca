import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../shared/agent-launch/contracts/agent-launch-surface'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

/** Proves no launch effects occurred, so replay may return the same definitive refusal. */
export class AgentLaunchSurfaceUnavailableError extends OrchestrationError {
  /** `data` adds recovery (`nextSteps`) only; the code and message stay what older clients match. */
  constructor(
    message: string,
    /** Why the chat can't open, so a caller can add the recovery that fits it. */
    readonly reason?: string,
    data?: Record<string, unknown>
  ) {
    super(AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE, message, data)
  }
}
