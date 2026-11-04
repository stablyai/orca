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

/** A Claude profile folder that cannot be created stops the launch instead of starting Claude without it. */
export function claudeConfigProfileFolderFailed(
  configDir: string,
  cause: unknown
): AgentSessionPreSpawnError {
  const detail = cause instanceof Error ? ` (${cause.message})` : ''
  return new AgentSessionPreSpawnError(cause, {
    reason: 'claudeAccountSetupFailed',
    message: `The Claude profile folder ${configDir} could not be created${detail}. Check its path in Settings > AI Provider Accounts.`
  })
}
