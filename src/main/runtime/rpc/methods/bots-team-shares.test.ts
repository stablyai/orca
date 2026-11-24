import { afterEach, describe, expect, it, vi } from 'vitest'
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
        botCloudAuth: async () => {
          inFlight += 1
          most = Math.max(most, inFlight)
          await Promise.resolve()
          await Promise.resolve()
          inFlight -= 1
          return { status: 'ok', value: inFlight === 0 }
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

describe('bots.teamShares.resend', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("posts the bot's mascot and services with the invite", async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ sent: true }), { status: 200 })
    })
    const bot: Partial<Bot> = {
      id: 'b1',
      name: 'Ivy',
      avatar: 'mascot:G1',
      slack: null,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the link's presence is read.
      slackApps: [{ appId: 'A1', teamId: 'T1' }] as Bot['slackApps'],
      linear: null,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the link's presence is read.
      github: {} as Bot['github'],
      shares: [{ kind: 'invite', shareId: 's1', email: 'dana@acme.co', addedAt: 1 }]
    }
    const resend = BOT_TEAM_SHARES_METHODS.find(
      (method) => method.name === 'bots.teamShares.resend'
    )!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
    const context = {
      runtime: {
        bots: {
          list: () => [bot],
          update: async (_id: string, edit: (saved: Partial<Bot>) => Partial<Bot>) => ({
            ...bot,
            ...edit(bot)
          })
        },
        botCloudAuth: async (
          operation: (token: string, apiBaseUrl: string) => Promise<boolean>
        ) => ({ status: 'ok', value: await operation('token', 'https://auth.example') })
      }
    } as unknown as Parameters<typeof resend.handler>[1]
    await resend.handler({ botId: 'b1', shareId: 's1' }, context)
    expect(bodies).toEqual([
      expect.objectContaining({
        to: 'dana@acme.co',
        agentName: 'Ivy',
        avatar: 'mascot:G1',
        connectors: ['slack', 'github']
      })
    ])
  })
})
