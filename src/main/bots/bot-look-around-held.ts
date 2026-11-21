// Per bot, the due slot the host's power held back (asleep, just woken or in a dark wake), and the
// schedule it was due under: only that slot, still due under that schedule, runs as late.
import type { Bot } from '../../shared/bot-types'
import { botLookAround } from '../../shared/bots/bot-look-around'

/** What a bot's looks are due under, to tell a held slot from one an edit made due. */
function scheduleKey(bot: Bot): string {
  const setting = botLookAround(bot)
  return JSON.stringify([setting.every, setting.times, setting.weekdaysOnly, setting.timezone])
}

export class HeldLookSlots {
  private readonly held = new Map<string, { slot: number; schedule: string }>()

  note(bot: Bot, slot: number): void {
    if (this.held.get(bot.id)?.slot !== slot) {
      console.info('[bots] look-around held until the host is in full wake', {
        botId: bot.id,
        slot
      })
    }
    this.held.set(bot.id, { slot, schedule: scheduleKey(bot) })
  }

  /** The slot was held for the host's power and is still due under the schedule it was held under. */
  isLate(bot: Bot, slot: number): boolean {
    const hold = this.held.get(bot.id)
    return hold?.slot === slot && hold.schedule === scheduleKey(bot)
  }

  clear(botId: string): void {
    this.held.delete(botId)
  }
}
