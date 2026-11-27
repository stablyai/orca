import type { HookCallback, Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { claudeLaunchServers } from '../../../bots/bot-tools-claude'
import { botToolsOffInstruction } from '../../../bots/bot-launch-tools'
import type { SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import { ownOrcaReadsOnly, type ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import {
  linkedSkillsSection,
  type LinkedSkillProject
} from '../../../native-chat/native-chat-skill-roots'
import {
  type ClaudeReadOnlyOptions,
  claudeReadOnlyOptions
} from '../../claude-structured-read-only-options'

/** Claude offers no allow rule for a command naming the CLI through a variable, so every Orca read
 *  would wait on a prompt; Orca answers those, and anything else keeps Claude's own check. */
const allowOwnOrcaReads: HookCallback = async (input) =>
  input.hook_event_name === 'PreToolUse' &&
  input.tool_name === 'Bash' &&
  typeof input.tool_input === 'object' &&
  input.tool_input !== null &&
  'command' in input.tool_input &&
  ownOrcaReadsOnly(input.tool_input.command)
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    : {}

/** What a chat adds over the base launch: its instructions, a read-only session's limits, and a
 *  bot's own tools on top of the owner's (a read-only session gets none, nor one whose managed
 *  settings refused them). */
export async function claudeBotSessionOptions(
  basis: {
    instructions(linkedSkills?: string | null): Promise<string | null>
    readOnly?: ReadOnlySessionMode | null
  },
  linked: readonly LinkedSkillProject[],
  tools: SessionMcpTools,
  refused: { mcpConfig: boolean }
): Promise<
  Pick<ClaudeAgentSdkOptions, 'systemPrompt' | 'mcpServers' | 'mcpServersDelivery'> &
    ClaudeReadOnlyOptions
> {
  // Claude loads every linked project's skills, so the section lists none as unloaded.
  const own = await basis.instructions(linkedSkillsSection(linked, []))
  // Managed settings that refuse --mcp-config would stop Claude starting; it starts without them.
  const toolsOff = tools.servers.length > 0 && refused.mcpConfig
  // Only a bot's own tools are announced off; the host list's go quietly (its settings page says why).
  const ownOff = toolsOff && tools.servers.length > tools.hostNames.size
  const instructions = ownOff
    ? [own, botToolsOffInstruction("your organization's Claude Code managed settings refuse them")]
        .filter(Boolean)
        .join('\n\n')
    : own
  return {
    ...(instructions
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } }
      : {}),
    ...(basis.readOnly
      ? claudeReadOnlyOptions(basis.readOnly)
      : { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [allowOwnOrcaReads] }] } }),
    // The user's own CLI may predate reading MCP servers from initialize, the SDK's planned default.
    ...(tools.servers.length > 0 && !toolsOff
      ? { mcpServers: claudeLaunchServers(tools), mcpServersDelivery: 'argv' as const }
      : {})
  }
}
