import type { PhoneBot } from './host-bots-operations'
import type { BotGroupItemReads } from './use-mobile-bot-group-transcript'
import type { PhoneBotItems } from './items/use-phone-bot-items'

/** A member's item read count: its own notices', and those naming every member. */
export function memberItemReads(reads: BotGroupItemReads, botId: string): number {
  return reads.all + (reads.bots[botId] ?? 0)
}

export function groupItemsFresh(
  bots: readonly Pick<PhoneBot, 'id'>[],
  reads: BotGroupItemReads,
  memberReads: ReadonlyMap<string, Pick<PhoneBotItems, 'currentReads' | 'error'>>
): boolean {
  return bots.every((bot) => {
    const read = memberReads.get(bot.id)
    return read?.error === null && read.currentReads === memberItemReads(reads, bot.id)
  })
}
