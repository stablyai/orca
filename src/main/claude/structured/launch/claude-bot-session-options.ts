import type { Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { claudeLaunchServers } from '../../../bots/bot-tools-claude'
import type { BotLaunchTools } from '../../../bots/bot-launch-tools'
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
 *  bot's own tools on top of the owner's (a read-only session gets none). */
export async function claudeBotSessionOptions(
  basis: {
    instructions(linkedSkills?: string | null): Promise<string | null>
    readOnly?: ReadOnlySessionMode | null
  },
  linked: readonly LinkedSkillProject[],
  tools: BotLaunchTools
): Promise<Pick<ClaudeAgentSdkOptions, 'systemPrompt' | 'mcpServers'> & ClaudeReadOnlyOptions> {
  // Claude loads every linked project's skills, so the section lists none as unloaded.
  const instructions = await basis.instructions(linkedSkillsSection(linked, []))
  return {
    ...(instructions
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } }
      : {}),
    ...(basis.readOnly ? claudeReadOnlyOptions(basis.readOnly) : {}),
    ...(tools.servers.length > 0 ? { mcpServers: claudeLaunchServers(tools) } : {})
  }
}
