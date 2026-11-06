import { AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE } from '../../shared/agent-launch/contracts/agent-launch-surface'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

/** Proves no launch effects occurred, so replay may return the same definitive refusal. */
export class AgentLaunchSurfaceUnavailableError extends OrchestrationError {
  constructor(message: string) {
    super(AGENT_LAUNCH_SURFACE_UNAVAILABLE_CODE, message)
  }
}

export const AGENT_LAUNCH_ATTACHMENT_EXPIRED_CODE = 'agent_launch_attachment_expired'

/** The chat's ordinary admission refused the opening message whole because a file it names is no
 *  longer stored: no chat, message or claim exists. A pre-effect failure, never a terminal fallback. */
export class AgentLaunchAttachmentExpiredError extends OrchestrationError {
  constructor(message: string) {
    super(AGENT_LAUNCH_ATTACHMENT_EXPIRED_CODE, message)
  }
}
