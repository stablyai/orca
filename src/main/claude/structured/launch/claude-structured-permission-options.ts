import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

export type ClaudePermissionOptions = Pick<ClaudeAgentSdkOptions, 'permissionMode' | 'extraArgs'>

const CLAUDE_PERMISSION_MODES = {
  // Override settings defaultMode so the chat runs with its selected permission mode.
  ask: 'default',
  'accept-edits': 'acceptEdits',
  auto: 'auto'
} as const satisfies Record<Exclude<AgentChatPermissionMode, 'full-access'>, PermissionMode>

/** Claude's own mode for a chat's pick; Full access is bypass, which only a flagged launch allows. */
export function claudePermissionModeFor(mode: AgentChatPermissionMode): PermissionMode {
  return mode === 'full-access' ? 'bypassPermissions' : CLAUDE_PERMISSION_MODES[mode]
}

/** Full access is the owned CLI flag: the SDK's typed bypass emits a flag older binaries reject. */
export function claudeStructuredPermissionOptions(
  mode: AgentChatPermissionChoice
): ClaudePermissionOptions {
  if (mode === 'own') {
    // An omitted mode lets the CLI apply the user's settings defaultMode.
    return {}
  }
  return mode === 'full-access'
    ? { extraArgs: { 'dangerously-skip-permissions': null } }
    : { permissionMode: CLAUDE_PERMISSION_MODES[mode] }
}
