import {
  CLAUDE_ACCOUNT_BINDING_UNAVAILABLE_MESSAGE,
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'

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

export function claudeAccountBindingUnavailable(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_ACCOUNT_BINDING_UNAVAILABLE_MESSAGE), {
    reason: 'claudeAccountBindingUnavailable'
  })
}
