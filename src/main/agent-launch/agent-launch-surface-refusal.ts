import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../shared/agent-launch-surface'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

/** Proves no launch effects occurred, so replay may return the same definitive refusal. */
export class AgentLaunchSurfaceUnavailableError extends OrchestrationError {
  constructor(message: string) {
    super(AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE, message)
  }
}
