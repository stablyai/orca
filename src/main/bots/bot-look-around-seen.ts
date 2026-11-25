// What the owner has seen of each bot's Up next, for the "N new" in it, its Activity tab and its sidebar row.
import type { Bot } from '../../shared/bot-types'
import { lookAroundOn, upNextItems, type BotLookState } from './bot-look-around-state'

/** Open suggestions the owner hasn't seen in Up next yet. */
export function unseenSuggestions(state: BotLookState, now: number): number {
  return upNextItems(state, now).filter((item) => item.createdAt > (state.seenAt ?? 0)).length
}

export function markUpNextSeen(state: BotLookState, now: number): BotLookState {
  return unseenSuggestions(state, now) === 0 ? state : { ...state, seenAt: now }
}

/** Each bot's count of new Up next suggestions, for its sidebar dot and Activity tab; bots with none are left out. */
export function upNextUnseenByBot(
  store: { get: (botId: string) => BotLookState },
  bots: readonly Pick<Bot, 'id' | 'agent' | 'lookAround'>[],
  now: number
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const bot of bots) {
    const unseen = lookAroundOn(bot) ? unseenSuggestions(store.get(bot.id), now) : 0
    if (unseen > 0) {
      counts[bot.id] = unseen
    }
  }
  return counts
}
