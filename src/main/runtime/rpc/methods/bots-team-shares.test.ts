import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { BOT_TEAM_SHARES_METHODS } from './bots-team-shares'

describe('bots.teamShares.add', () => {
  it('emails invites one at a time, so the cloud never refuses one as a concurrent send', async () => {
    let bot: Partial<Bot> = { id: 'b1', name: 'Ada', shares: [] }
    let inFlight = 0
    let most = 0
    const add = BOT_TEAM_SHARES_METHODS.find((method) => method.name === 'bots.teamShares.add')!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
    const context = {
      runtime: {
        bots: {
          update: async (_id: string, edit: (saved: Partial<Bot>) => Partial<Bot>) => {
            bot = { ...bot, ...edit(bot) }
            return bot
          }
        },
        // The cloud answers a second send that overlaps the first with 429: not sent.
        emailBotInvite: async () => {
          inFlight += 1
          most = Math.max(most, inFlight)
          await Promise.resolve()
          await Promise.resolve()
          inFlight -= 1
          return inFlight === 0
        }
      }
    } as unknown as Parameters<typeof add.handler>[1]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: add answers { bot, added }.
    const { added } = (await add.handler(
      { botId: 'b1', emails: ['a@example.com', 'b@example.com', 'c@example.com'] },
      context
    )) as { added: { kind: string; emailedAt?: number }[] }
    expect(most).toBe(1)
    expect(added.every((share) => share.kind === 'invite' && share.emailedAt !== undefined)).toBe(
      true
    )
  })
})
