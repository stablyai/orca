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

// Why refuse, not fall back: the selected account would run a launch chosen for another one.
export function claudeChosenAccountUnknown(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_CHOSEN_ACCOUNT_UNKNOWN_MESSAGE), {
    reason: 'launchPreparationFailed'
  })
}

export function claudeChosenAccountUnsupported(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_CHOSEN_ACCOUNT_UNSUPPORTED_MESSAGE), {
    reason: 'launchPreparationFailed'
  })
}
