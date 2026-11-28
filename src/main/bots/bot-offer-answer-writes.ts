import type { Bot } from '../../shared/bot-types'
import type { BotOfferAnswer } from '../../shared/bots/bot-offer-answers'
import type { BotHostUpdates } from '../../shared/rpc-contract/bots-params'
import { persistBotStore, type BotStore } from './bot-controller-store'

export type PendingBotOfferAnswer = {
  botId: string
  selection: BotOfferAnswer
  googleAction?: { id: string; admissionCutoff: number }
}

/** How long an older client's claim on a card counts as still being sent. Its success is never
 *  reported, so after this the claim is taken as told. */
export const LEGACY_OFFER_CLAIM_SEND_MS = 15_000

export class BotOfferAnswerWrites {
  readonly pending = new Map<string, PendingBotOfferAnswer>()
  /** The turn id a card's answer was sent under, kept until its write is confirmed, so a retry after a
   *  lost or failed send replays that turn instead of admitting the answer again. */
  readonly operations = new Map<string, { botId: string; operationId: string }>()
  /** When an older client claimed a card before telling the bot, by card key; a release removes it. */
  private readonly claims = new Map<string, { botId: string; at: number }>()
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

  async save(
    store: BotStore,
    previous: Bot,
    next: Bot,
    updates: Pick<BotHostUpdates, 'offerAnswer' | 'offerAnswerConfirmation'>
  ): Promise<void> {
    const cardId = updates.offerAnswerConfirmation?.cardId
    if (!cardId) {
      store.saveBot(next)
      if (updates.offerAnswer) {
        this.noteClaim(previous.id, updates.offerAnswer)
      }
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

  /** Notes an older client's claim (`bots.update` with `claim`) or its release after a refused send. */
  noteClaim(
    botId: string,
    update: { cardId: string; claim?: true; release?: string },
    now = Date.now()
  ): void {
    const key = offerAnswerKey(botId, update.cardId)
    if (update.release) {
      this.claims.delete(key)
    } else if (update.claim) {
      this.claims.set(key, { botId, at: now })
    }
  }

  /** An older client claimed this card recently and may still be telling the bot. */
  claimInFlight(key: string, now = Date.now()): boolean {
    const claim = this.claims.get(key)
    if (!claim) {
      return false
    }
    if (now - claim.at < LEGACY_OFFER_CLAIM_SEND_MS) {
      return true
    }
    this.claims.delete(key)
    return false
  }

  forget(botId: string): void {
    this.unconfirmed.delete(botId)
    for (const map of [this.pending, this.operations, this.claims]) {
      for (const [key, entry] of map) {
        if (entry.botId === botId) {
          map.delete(key)
        }
      }
    }
  }
}

/** The key the host serializes one bot's card answers under. */
export function offerAnswerKey(botId: string, cardId: string): string {
  return JSON.stringify([botId, cardId])
}
