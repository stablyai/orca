import {
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../shared/claude-profile-routing'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export function claudeProfileMissing(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_PROFILE_MISSING_MESSAGE), {
    reason: 'claudeAccountFolderMissing'
  })
}

export function claudeProfileSetupFailed(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_PROFILE_SETUP_FAILED_MESSAGE), {
    reason: 'claudeAccountSetupFailed'
  })
}
