// A read-only Claude session (a bot's look-around or tidy-up): every tool call is decided by Orca.
import type { HookCallback, Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import {
  LOOK_AROUND_DISALLOWED_TOOLS,
  LOOK_AROUND_REFUSAL,
  lookAroundToolDecision,
  type ReadOnlySessionMode,
  REPLY_ONLY_REFUSAL
} from '../bots/bot-look-around-policy'

/** An SDK hook beats the user's allow rules and full access, and covers MCP tools. */
function preToolUse(mode: ReadOnlySessionMode): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {}
    }
    const decision =
      mode === 'look-around' ? lookAroundToolDecision(input.tool_name, input.tool_input) : 'deny'
    const reason = mode === 'look-around' ? LOOK_AROUND_REFUSAL : REPLY_ONLY_REFUSAL
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        ...(decision === 'deny' ? { permissionDecisionReason: reason } : {})
      }
    }
  }
}

export const claudeReadOnlyPreToolUse: HookCallback = preToolUse('look-around')

export type ClaudeReadOnlyOptions = Pick<
  ClaudeAgentSdkOptions,
  'hooks' | 'disallowedTools' | 'tools' | 'strictMcpConfig' | 'settings'
>

/** A reply-only run also gets no built-in tools, no MCP servers from any config, and none of the
 *  hooks the user's settings or plugins configure. */
export function claudeReadOnlyOptions(
  mode: ReadOnlySessionMode = 'look-around'
): ClaudeReadOnlyOptions {
  const guarded = {
    hooks: { PreToolUse: [{ hooks: [preToolUse(mode)] }] },
    disallowedTools: [...LOOK_AROUND_DISALLOWED_TOOLS]
  }
  return mode === 'look-around'
    ? guarded
    : { ...guarded, tools: [], strictMcpConfig: true, settings: { disableAllHooks: true } }
}
