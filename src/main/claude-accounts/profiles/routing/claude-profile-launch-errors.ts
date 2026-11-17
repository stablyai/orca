import {
  CLAUDE_CHOSEN_ACCOUNT_UNKNOWN_MESSAGE,
  CLAUDE_CHOSEN_ACCOUNT_UNSUPPORTED_MESSAGE,
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

/** Plain errors: only terminal launches choose an account, and they show the message itself. */
export function claudeChosenAccountUnknown(): Error {
  return new Error(CLAUDE_CHOSEN_ACCOUNT_UNKNOWN_MESSAGE)
}

export function claudeChosenAccountUnsupported(): Error {
  return new Error(CLAUDE_CHOSEN_ACCOUNT_UNSUPPORTED_MESSAGE)
}
