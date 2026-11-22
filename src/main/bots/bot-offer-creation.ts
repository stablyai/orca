// Creating a bot from a bot's offer card: one bot per card, however many devices press Create. The
// card's bot and the proposer's record of it are saved together; an install that follows (a template's
// package) is part of the same step, so other callers wait for it, and a failed one reopens the card.
import type { Bot } from '../../shared/bot-types'
import { withAcceptedOffer } from '../../shared/bots/bot-proposal'
import type { BotCreateParams } from '../../shared/rpc-contract/bots-params'

type FromOffer = NonNullable<BotCreateParams['fromOffer']>
export type BotOfferCreateInput = BotCreateParams & { fromOffer: FromOffer }
export type BotOfferCreated = { bot: Bot | null; existing: boolean }
type OfferStore = { getBots: () => Bot[]; saveBot: (bot: Bot) => void }

export type BotOfferCreationDeps<Store extends OfferStore, Origin> = {
  /** Runs `work` in the bots queue with the store. */
  queue: <T>(work: (store: Store) => Promise<T>) => Promise<T>
  /** The new bot with its home written, not yet saved; runs inside the queue. */
  makeBot: (store: Store, input: BotOfferCreateInput, origin?: Origin) => Promise<Bot>
  /** Saves now and tells every window and phone. */
  saved: (store: Store) => Promise<void>
}

export function botOfferCreation<Store extends OfferStore, Origin>(
  deps: BotOfferCreationDeps<Store, Origin>
) {
  const creating = new Map<string, Promise<BotOfferCreated>>()

  /** The card's bot, made and recorded together, or the one it already made (null once deleted). */
  const accept = (input: BotOfferCreateInput, origin?: Origin) =>
    deps.queue(async (store): Promise<BotOfferCreated> => {
      if (!input.fromOffer.botId) {
        const made = store.getBots().find((bot) => bot.fromOfferId === input.fromOffer.offerId)
        if (made) {
          return { bot: made, existing: true }
        }
        const bot = await deps.makeBot(store, input, origin)
        store.saveBot(bot)
        await deps.saved(store)
        return { bot, existing: false }
      }
      const proposer = store.getBots().find((bot) => bot.id === input.fromOffer.botId)
      if (!proposer) {
        throw new Error('bot_not_found')
      }
      const accepted = proposer.acceptedOffers?.find(
        (entry) => entry.offerId === input.fromOffer.offerId
      )
      if (accepted) {
        return {
          bot: store.getBots().find((bot) => bot.id === accepted.botId) ?? null,
          existing: true
        }
      }
      const bot = await deps.makeBot(store, input, origin)
      store.saveBot(bot)
      store.saveBot({
        ...proposer,
        acceptedOffers: withAcceptedOffer(proposer, input.fromOffer.offerId, bot.id),
        updatedAt: Date.now()
      })
      await deps.saved(store)
      return { bot, existing: false }
    })

  /** Reopens a card whose bot was rolled back; an owner's later delete keeps the card answered. */
  const reopen = (fromOffer: FromOffer, botId: string) =>
    deps.queue(async (store) => {
      const proposer = fromOffer.botId
        ? store.getBots().find((bot) => bot.id === fromOffer.botId)
        : undefined
      if (proposer) {
        store.saveBot({
          ...proposer,
          acceptedOffers: proposer.acceptedOffers?.filter(
            (entry) => !(entry.offerId === fromOffer.offerId && entry.botId === botId)
          ),
          updatedAt: Date.now()
        })
        await deps.saved(store)
      }
    })

  return (
    input: BotOfferCreateInput,
    origin?: Origin,
    install?: (bot: Bot) => Promise<Bot>
  ): Promise<BotOfferCreated> => {
    const key = `${input.fromOffer.botId ?? ''}\n${input.fromOffer.offerId}`
    const pending = creating.get(key)
    if (pending) {
      return pending.then((made) => ({ ...made, existing: true }))
    }
    const creation = (async () => {
      const made = await accept(input, origin)
      if (made.existing || !made.bot || !install) {
        return made
      }
      const bot = made.bot
      try {
        return { bot: await install(bot), existing: false }
      } catch (error) {
        // The install already removed the partly made bot.
        await reopen(input.fromOffer, bot.id)
        throw error
      }
    })().finally(() => creating.delete(key))
    creating.set(key, creation)
    return creation
  }
}
