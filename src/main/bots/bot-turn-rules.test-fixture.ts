// A launch whose Tools and Rules the session already holds, for tests about everything else.
import { botRulesKey, type BotLaunchedRules } from './bot-turn-rules-update'

const HELD = { block: '## Tools\n\n- one\n\n## Rules\n\n- one', name: 'Scout' }

export const HELD_BOT_RULES: BotLaunchedRules = {
  ...HELD,
  delivered: true,
  rebuilt: false,
  recorded: botRulesKey(HELD)
}

/** The agent took the turn and its receipt was written. */
export const TAKEN = { instructionsRecorded: true } as const
