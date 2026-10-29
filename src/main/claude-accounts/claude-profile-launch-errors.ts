import {
  CLAUDE_ACCOUNT_UNKNOWN_MESSAGE,
  CLAUDE_ACCOUNT_WSL_UNSUPPORTED_MESSAGE,
  CLAUDE_PROFILE_MISSING_MESSAGE,
  CLAUDE_PROFILE_SETUP_FAILED_MESSAGE
} from '../../shared/claude-profile-routing'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

// Typed so a chat names the situation; a terminal reads the same message. The two chosen-account
// messages are machine codes instead: the mover matches these exact strings, and the user-facing
// copy comes from the `reason` code through the failure tables.
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

export function claudeAccountUnknown(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_ACCOUNT_UNKNOWN_MESSAGE), {
    reason: 'claudeAccountUnknown'
  })
}

export function claudeAccountWslUnsupported(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error(CLAUDE_ACCOUNT_WSL_UNSUPPORTED_MESSAGE), {
    reason: 'claudeAccountWslUnsupported'
  })
}
