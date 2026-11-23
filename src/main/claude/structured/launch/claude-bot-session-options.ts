import type { Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { claudeLaunchServers } from '../../../bots/bot-tools-claude'
import { botToolsOffInstruction, type BotLaunchTools } from '../../../bots/bot-launch-tools'
import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import {
  linkedSkillsSection,
  type LinkedSkillProject
} from '../../../native-chat/native-chat-skill-roots'
import {
  type ClaudeReadOnlyOptions,
  claudeReadOnlyOptions
} from '../../claude-structured-read-only-options'

/** What a chat adds over the base launch: its instructions, a read-only session's limits, and a
 *  bot's own tools on top of the owner's (a read-only session gets none, nor one whose managed
 *  settings refused them). */
export async function claudeBotSessionOptions(
  basis: {
    instructions(linkedSkills?: string | null): Promise<string | null>
    readOnly?: ReadOnlySessionMode | null
  },
  linked: readonly LinkedSkillProject[],
  tools: BotLaunchTools,
  refused: { mcpConfig: boolean }
): Promise<Pick<ClaudeAgentSdkOptions, 'systemPrompt' | 'mcpServers'> & ClaudeReadOnlyOptions> {
  // Claude loads every linked project's skills, so the section lists none as unloaded.
  const own = await basis.instructions(linkedSkillsSection(linked, []))
  // Managed settings that refuse --mcp-config would stop Claude starting; it starts without them.
  const toolsOff = tools.servers.length > 0 && refused.mcpConfig
  const instructions = toolsOff
    ? [own, botToolsOffInstruction("your organization's Claude Code managed settings refuse them")]
        .filter(Boolean)
        .join('\n\n')
    : own
  return {
    ...(instructions
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } }
      : {}),
    ...(basis.readOnly ? claudeReadOnlyOptions(basis.readOnly) : {}),
    ...(tools.servers.length > 0 && !toolsOff ? { mcpServers: claudeLaunchServers(tools) } : {})
  }
}
