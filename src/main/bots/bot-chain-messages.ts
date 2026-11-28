// What a bot's chat messages are to a chain of bots: a person's own words, or another Orca bot's post.
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { isRootUserMessage } from './bot-turn-messages'

/** A connector asker who is a person: neither an Orca bot posting for someone (`via`) nor another
 *  Slack app (`app`). */
export function isPersonAsker(asker: { via?: unknown; app?: true } | null | undefined): boolean {
  return !!asker && !asker.via && !asker.app
}

/** What a chat message is to a chain of bots: a person's own words start a new one, and another Orca
 *  bot's post (`via`) is a hop in it; mail, events, automation prompts and another Slack app's post
 *  (`app`, never a person) are neither. */
export function chainRoleOf(body: AgentJournalItemBody): 'person' | 'bot' | null {
  if (body.kind !== 'message' || body.from || body.memorySource) {
    return null
  }
  if (body.asker) {
    return body.asker.via ? 'bot' : isPersonAsker(body.asker) ? 'person' : null
  }
  // An agent typing through the orca CLI is no person.
  return body.origin === 'connector' || body.typedBy?.by === 'agent' ? null : 'person'
}

/** Other Orca bots' posts that woke this chat in a row, counted from the newest message back to a
 *  person's own or `personSince`; `decided` is false when the items ran out first. Counting stops at
 *  `upTo`. */
export function botWakesInARow(
  items: readonly AgentJournalRenderItem[],
  upTo: number,
  personSince = 0
): { wakes: number; decided: boolean } {
  let wakes = 0
  for (const item of items.toReversed()) {
    if (item.observedAt <= personSince) {
      return { wakes, decided: true }
    }
    const role = isRootUserMessage(item) ? chainRoleOf(item.body) : null
    if (role === 'person') {
      return { wakes, decided: true }
    }
    if (role === 'bot' && ++wakes >= upTo) {
      return { wakes, decided: true }
    }
  }
  return { wakes, decided: false }
}
