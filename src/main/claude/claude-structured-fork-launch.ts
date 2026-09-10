import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  claudeSessionIdForOrcaSession,
  type ClaudeStructuredLaunch
} from './claude-structured-launch-resolution'

/** Rejections here are PRE-SPAWN by construction: this only rewrites launch arguments, and its one
 *  caller runs it before the child is opened. Saying so lets the wire settle the fork attempt
 *  instead of stranding the child record at `attempted`, which wedges the turn until app reload. */
export function applyClaudeStructuredForkLaunch(
  launch: ClaudeStructuredLaunch,
  fork: AgentSessionForkTarget,
  sessionId: string
): ClaudeStructuredLaunch {
  if (
    fork.source.provider !== 'claude' ||
    (launch.resumed && launch.providerSessionId !== fork.source.sessionId)
  ) {
    throw new AgentSessionPreSpawnError(new Error('agent_session_identity_required'))
  }
  const providerSessionId = claudeSessionIdForOrcaSession(sessionId)
  if (providerSessionId === fork.source.sessionId) {
    throw new AgentSessionPreSpawnError(new Error('agent_session_provider_handle_invalid'))
  }
  return {
    ...launch,
    providerSessionId,
    resumeLeafUuid: fork.throughId,
    resumed: false,
    options: {
      ...launch.options,
      resume: fork.source.sessionId,
      resumeSessionAt: fork.throughId,
      forkSession: true,
      sessionId: providerSessionId
    }
  }
}
