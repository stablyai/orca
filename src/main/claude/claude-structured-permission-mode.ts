import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode,
  type AgentSessionPermissionModes
} from '../../shared/agent-chat-permission-mode'
import type { ListedModel } from './claude-structured-model-catalog'

const CLAUDE_SDK_PERMISSION_MODES = {
  ask: 'default',
  'accept-edits': 'acceptEdits',
  auto: 'auto',
  bypass: 'bypassPermissions'
} as const satisfies Record<AgentChatPermissionMode, PermissionMode>

/** The chat's mode as Claude's own `set_permission_mode` / `--permission-mode` value. */
export function claudeSdkPermissionMode(mode: AgentChatPermissionMode): PermissionMode {
  return CLAUDE_SDK_PERMISSION_MODES[mode]
}

/** Starts in the chat's mode without a restore request or a newer bypass-allow flag. */
export function claudeStructuredPermissionOptions(mode: AgentChatPermissionMode): {
  permissionMode?: PermissionMode
  extraArgs?: Record<string, string | null>
} {
  if (mode === 'bypass') {
    return { extraArgs: { 'dangerously-skip-permissions': null } }
  }
  return { permissionMode: claudeSdkPermissionMode(mode) }
}

/** The chat mode a Claude child runs and the one the chat now wants. */
export type ClaudePermissionModeState = {
  options: ReadonlyMap<string, string>
  /** What the child was launched for; absent was launched without the bypass flag. */
  launchPermissionMode?: AgentChatPermissionMode
}

/** The chat's mode: its own pick, else what its child was launched for. */
export function claudeChatPermissionMode(
  session: ClaudePermissionModeState
): AgentChatPermissionMode {
  const picked = session.options.get(AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
  return picked !== undefined
    ? isAgentChatPermissionMode(picked)
      ? picked
      : 'ask'
    : (session.launchPermissionMode ?? 'ask')
}

/** Full access needs an idle relaunch when the child lacks the bypass flag. */
export function claudePermissionModeNeedsRelaunch(session: ClaudePermissionModeState): boolean {
  return claudeChatPermissionMode(session) === 'bypass' && session.launchPermissionMode !== 'bypass'
}

/** Offer Auto until a listed model rules it out; retained intent still names the pill. */
export function claudePermissionModesFor(
  session: ClaudePermissionModeState,
  currentModel: Pick<ListedModel, 'supportsAutoMode'> | undefined
): AgentSessionPermissionModes {
  const current = claudeChatPermissionMode(session)
  // Claude omits the flag for a listed model without Auto.
  const autoReview = currentModel === undefined || currentModel.supportsAutoMode === true
  const supported = agentChatPermissionModes('claude', { autoReview }) ?? []
  return { current, supported }
}

/** Bypass without its launch flag is saved for relaunch; other modes apply live. */
export function claudePermissionModeWrite(
  session: ClaudePermissionModeState,
  value: string
): { kind: 'live'; mode: PermissionMode } | { kind: 'relaunch' } | null {
  if (!isAgentChatPermissionMode(value) || !agentChatPermissionModes('claude')?.includes(value)) {
    return null
  }
  return claudePermissionModeNeedsRelaunch({
    options: new Map([[AGENT_CHAT_PERMISSION_MODE_OPTION_ID, value]]),
    ...(session.launchPermissionMode ? { launchPermissionMode: session.launchPermissionMode } : {})
  })
    ? { kind: 'relaunch' }
    : { kind: 'live', mode: claudeSdkPermissionMode(value) }
}
