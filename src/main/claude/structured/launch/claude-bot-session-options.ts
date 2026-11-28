import type { Options as ClaudeAgentSdkOptions } from '@anthropic-ai/claude-agent-sdk'
import { claudeLaunchServers } from '../../../bots/bot-tools-claude'
import { botToolsOffInstruction } from '../../../bots/bot-launch-tools'
import type { SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import {
  linkedSkillsSection,
  type LinkedSkillProject
} from '../../../native-chat/native-chat-skill-roots'
import {
  type ClaudeReadOnlyOptions,
  claudeReadOnlyOptions
} from '../../claude-structured-read-only-options'
import { CLAUDE_AUTO_COMPACT_PERCENT_ENV } from '../../../../shared/bots/bot-launch'

/** What a chat adds over the base launch: its instructions, a read-only session's limits, and a
 *  bot's own tools on top of the owner's (a read-only session gets none, nor one whose managed
 *  settings refused them). */
export async function claudeBotSessionOptions(
  basis: {
    instructions(linkedSkills?: string | null): Promise<string | null>
    readOnly?: ReadOnlySessionMode | null
    autoCompactPercent?: number
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
  const readOnly = basis.readOnly ? claudeReadOnlyOptions(basis.readOnly) : {}
  const settings = withAutoCompactPercent(readOnly.settings, basis.autoCompactPercent)
  return {
    ...(instructions
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } }
      : {}),
    ...readOnly,
    ...(settings ? { settings } : {}),
    // The user's own CLI may predate reading MCP servers from initialize, the SDK's planned default.
    ...(tools.servers.length > 0 && !toolsOff
      ? { mcpServers: claudeLaunchServers(tools), mcpServersDelivery: 'argv' as const }
      : {})
  }
}

/** A bot's threshold rides the flag settings layer: an inherited env var would lose to settings files. */
function withAutoCompactPercent(
  settings: ClaudeReadOnlyOptions['settings'],
  percent: number | undefined
): ClaudeReadOnlyOptions['settings'] {
  if (percent === undefined || typeof settings === 'string') {
    return settings
  }
  return {
    ...settings,
    env: { ...settings?.env, [CLAUDE_AUTO_COMPACT_PERCENT_ENV]: String(percent) }
  }
}
