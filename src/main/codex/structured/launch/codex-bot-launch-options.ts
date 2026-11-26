// What a bot's Codex chat adds to a structured launch.
import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import type { CodexInstructionInstallation } from '../threads/codex-bot-instruction-installation'

export type CodexBotLaunchOptions = {
  instructionInstallation?: CodexInstructionInstallation
  /** Canonical configuration for fresh and cold-resumed threads. */
  developerInstructions?: string
  /** A bot's look-around or tidy-up: the host answers its approvals by this mode. */
  readOnly?: ReadOnlySessionMode
  /** Read-only sessions' config: MCP servers, plugins and web search off. */
  threadConfig?: Record<string, unknown>
  /** The bot's linked-skills folder, an extra root Codex rereads as Orca updates it;
   *  developerInstructions says how to use its skills. */
  linkedSkillsRoot?: string
  /** Codex turned the roots down, so the bot's turns list the skills, with paths, instead. */
  linkedSkillsRefused?: () => void
}
