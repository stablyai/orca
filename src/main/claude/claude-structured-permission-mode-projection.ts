import { readStructuredAgentSessionPermissionMode } from '../../shared/structured-agent-session-permission-mode'
import type { ClaudeSession } from './claude-structured-session-state'

export function claudePublishedPermissionMode(session: ClaudeSession): {
  value: ClaudeSession['basePermissionMode']
  reported: boolean
} {
  const requested = readStructuredAgentSessionPermissionMode(session.options.get('permissionMode'))
  const reported =
    session.reportedPermissionModeMutation === session.permissionModeMutationSequence
      ? session.reportedOptions.permissionMode
      : undefined
  const value =
    requested === session.basePermissionMode
      ? (reported ?? requested)
      : (requested ?? reported ?? session.basePermissionMode)
  return { value, reported: value !== undefined && value === reported }
}
