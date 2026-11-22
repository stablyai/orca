// Orca's Tools and Rules a running bot chat should have, with the bot's name, against what its
// provider context holds. The block is the host's own: a newer build's reaches a chat on its first
// turn under that build, and a rename on the next turn of each chat.

import type { StructuredAgentSessionTurnContextPlan } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import { botTurnFingerprint as fingerprint } from './bot-turn-memory-update'
import { botNameLine } from './bot-preamble'

// Bumped when stored keys stop vouching for contexts; v2: resumed Claude kept its first prompt.
const KEY_VERSION = 'v2'

/** What an update sends: the launch prompt's name line, then the block. */
const rulesText = ({ block, name }: { block: string; name: string }): string =>
  `${botNameLine(name)}\n\n${block}`

/** The key a session's receipt stores for what an update sends. */
export const botRulesKey = (rules: { block: string; name: string }): string =>
  fingerprint(`${KEY_VERSION}\n${rulesText(rules)}`)

const COPY =
  '[Orca rules update: your name and the Tools and Rules below replace the earlier ones in your instructions; nothing else changes.]'

/** What a launch knows of the block. */
export type BotLaunchedRules = {
  /** The Tools and Rules this host renders for the session's agent. */
  block: string
  /** The bot's name the launch prompt states. */
  name: string
  /** Whether the launch gave the agent `block` (a fresh context, or one that rebuilds its prompt). */
  delivered: boolean
  /** The session's receipt: the key its context was confirmed to hold; null: unknown. */
  recorded: string | null
  /** Whether the agent rebuilds its prompt on every start, resumed or not. */
  rebuilt: boolean
}

export type BotTurnRules = {
  block: string
  /** The bot's name as of the latest turn, or the launch's. */
  name: string
  /** The key the agent holds, as far as Orca knows; null: unknown, so the next turn sends it. */
  held: string | null
  /** The session's receipt as this host last knew it. */
  recorded: string | null
  rebuilt: boolean
}

export function botLaunchedTurnRules(launch: BotLaunchedRules): BotTurnRules {
  const { block, name, delivered, recorded, rebuilt } = launch
  return { block, name, held: delivered ? botRulesKey(launch) : recorded, recorded, rebuilt }
}

/** What a confirmed open records: the key, and whether any context it opens was given it. */
export function botLaunchedInstructions(rules: BotTurnRules): { key: string; rebuilt: boolean } {
  return { key: botRulesKey(rules), rebuilt: rules.rebuilt }
}

/** `plan` with the block put first when the agent may not hold it, or only its receipt owed when the
 *  launch gave it. At least once: only a written receipt moves `held`, so an unwritten one (a crash,
 *  a takeover) sends the block again. */
export function withBotRulesUpdate(
  known: BotTurnRules,
  /** The record's receipt now; when it moved from what this host knew (a rewind dropped it, an
   *  open set it), it is what the agent's context holds. */
  held: string | null | undefined,
  plan: StructuredAgentSessionTurnContextPlan | null,
  keep: (rules: BotTurnRules) => void
): StructuredAgentSessionTurnContextPlan | null {
  const moved = held !== undefined && held !== known.recorded
  const rules = moved ? { ...known, held, recorded: held } : known
  if (moved) {
    keep(rules)
  }
  const key = botRulesKey(rules)
  const send = rules.held !== key
  if (!send && rules.recorded === key) {
    return plan
  }
  return {
    ...plan,
    text: [
      ...(send ? [`${COPY}\n\n${rulesText(rules)}`] : []),
      ...(plan?.text ? [plan.text] : [])
    ].join('\n\n'),
    instructionsKey: key,
    given: (receipt) => {
      plan?.given(receipt)
      if (receipt.instructionsRecorded) {
        keep({ ...rules, held: key, recorded: key })
      }
    }
  }
}
