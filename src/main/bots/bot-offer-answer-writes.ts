import type { Bot } from '../../shared/bot-types'
import type { BotOfferAnswer } from '../../shared/bots/bot-offer-answers'
import { persistBotStore, type BotStore } from './bot-controller-store'

export type PendingBotOfferAnswer = {
  botId: string
  selection: BotOfferAnswer
  googleAction?: { id: string; admissionCutoff: number }
}

export class BotOfferAnswerWrites {
  readonly pending = new Map<string, PendingBotOfferAnswer>()
  private readonly unconfirmed = new Map<string, Map<string, BotOfferAnswer | undefined>>()

  list(bots: Bot[]): Bot[] {
    return this.unconfirmed.size ? bots.map((bot) => this.project(bot)) : bots
  }

  project(bot: Bot): Bot {
    const masked = this.unconfirmed.get(bot.id)
    if (!masked) {
      return bot
    }
    const visible = bot.offerAnswers?.filter((entry) => !masked.has(entry.cardId)) ?? []
    for (const previous of masked.values()) {
      if (previous) {
        visible.push(previous)
      }
    }
    return { ...bot, offerAnswers: visible.length ? visible : undefined }
  }

  async save(store: BotStore, previous: Bot, next: Bot, cardId?: string): Promise<void> {
    if (!cardId) {
      store.saveBot(next)
      return
    }
    // The profile store stages writes in memory before its flush.
    const masked = this.unconfirmed.get(previous.id) ?? new Map()
    if (!masked.has(cardId)) {
      masked.set(
        cardId,
        previous.offerAnswers?.find((entry) => entry.cardId === cardId)
      )
    }
    this.unconfirmed.set(previous.id, masked)
    store.saveBot(next)
    await persistBotStore(store)
    this.unconfirmed.delete(previous.id)
  }

  forget(botId: string): void {
    this.unconfirmed.delete(botId)
    for (const [key, write] of this.pending) {
      if (write.botId === botId) {
        this.pending.delete(key)
      }
    }
  }
}
