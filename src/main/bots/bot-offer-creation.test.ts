import { describe, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { makeTestBot } from './bot.test-fixture'
import { botOfferCreation } from './bot-offer-creation'

/** The bots queue over an in-memory store, as the controller runs it. */
function offerHost() {
  const saved = new Map<string, Bot>([['atlas', makeTestBot({ id: 'atlas', name: 'Atlas' })]])
  const store = {
    getBots: () => [...saved.values()],
    saveBot: (bot: Bot) => void saved.set(bot.id, bot)
  }
  let tail: Promise<unknown> = Promise.resolve()
  let made = 0
  const create = botOfferCreation<typeof store, never>({
    queue: (work) => {
      const run = tail.then(() => work(store))
      tail = run.catch(() => undefined)
      return run
    },
    makeBot: async (_store, input) => makeTestBot({ id: `made-${++made}`, name: input.name }),
    saved: async () => {}
  })
  return { create, saved, store }
}

const fromOffer = { botId: 'atlas', offerId: 'offer-1' }

describe('bot offer creation', () => {
  it('reopens the card when the install fails, so a retry makes the bot', async () => {
    const { create, saved } = offerHost()
    // As applyBotPackage does: a failed install removes the partly made bot, then fails.
    const failing = async (bot: Bot) => {
      saved.delete(bot.id)
      throw new Error('disk full')
    }
    await expect(create({ name: 'Release', fromOffer }, undefined, failing)).rejects.toThrow(
      'disk full'
    )
    expect(saved.get('atlas')?.acceptedOffers).toEqual([])

    const retried = await create({ name: 'Release', fromOffer }, undefined, async (bot) => bot)
    expect(retried).toEqual({ bot: expect.objectContaining({ id: 'made-2' }), existing: false })
    expect(saved.get('atlas')?.acceptedOffers).toEqual([{ offerId: 'offer-1', botId: 'made-2' }])
  })

  it('gives a second Create the bot only once its install is done', async () => {
    const { create, store } = offerHost()
    const installs: string[] = []
    const install = async (bot: Bot) => {
      installs.push(bot.id)
      return { ...bot, updatedAt: -1 }
    }
    const [first, second] = await Promise.all([
      create({ name: 'Release', fromOffer }, undefined, install),
      create({ name: 'Cutter', fromOffer }, undefined, install)
    ])
    expect(installs).toEqual(['made-1'])
    expect(first).toEqual({ bot: expect.objectContaining({ updatedAt: -1 }), existing: false })
    expect(second).toEqual({ bot: first.bot, existing: true })
    expect(store.getBots().map((bot) => bot.name)).toEqual(['Atlas', 'Release'])
  })
})
