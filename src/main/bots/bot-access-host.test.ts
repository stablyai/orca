import { describe, expect, it, vi } from 'vitest'
import { BOT_MAX_MEMBERS, type Bot } from '../../shared/bot-types'
import { applyBotUpdates, type BotUpdateParams } from '../../shared/rpc-contract/bots-params'
import { makeAccessRequest } from '../../shared/bots/bot-access-request.test-fixture'
import type { ConnectorCloud } from '../connector-cloud/connector-cloud'
import { makeTestBot } from './bot.test-fixture'
import { fakeAccessCloud } from './bot-access-cloud.test-fixture'
import {
  decideHostAccessRequest,
  listHostAccessRequests,
  redeemHostAccessRequest,
  type BotAccessHostDeps
} from './bot-access-host'

function hostWith(bot: Bot, cloud: Pick<ConnectorCloud, 'call'> | null) {
  let saved = bot
  const updateBot = vi.fn(
    async (_botId: string, edit: (current: Bot) => BotUpdateParams['updates']) => {
      saved = applyBotUpdates(saved, edit(saved))
      return saved
    }
  )
  const deps: BotAccessHostDeps = {
    bots: () => [saved],
    cloud: () => cloud,
    updateBot
  }
  return { deps, updateBot, saved: () => saved }
}

const slackBot = makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })

describe('host access requests', () => {
  it("lists only requests this host's bots take", async () => {
    const mine = makeAccessRequest()
    const otherHost = makeAccessRequest({ requestId: 'req-2', botId: 'elsewhere' })
    const oldWorkspace = makeAccessRequest({ requestId: 'req-3', workspaceId: 'T-old' })
    const { cloud } = fakeAccessCloud([mine, otherHost, oldWorkspace])

    expect(await listHostAccessRequests(hostWith(slackBot, cloud).deps)).toEqual({
      ok: true,
      value: [mine]
    })
  })

  it('grants in the cloud first, then adds the person, and records the device', async () => {
    const { cloud, call, decisions } = fakeAccessCloud([makeAccessRequest()])
    const host = hostWith(slackBot, cloud)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const answer = await decideHostAccessRequest(
      host.deps,
      { requestId: 'req-1', decision: 'granted' },
      'phone-7'
    )

    expect(answer).toMatchObject({ ok: true })
    expect(host.saved().members).toEqual([
      { id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T1' }
    ])
    // The decision is the cloud's last call, so the add follows it.
    expect(host.updateBot.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...call.mock.invocationCallOrder)
    )
    expect(decisions).toEqual([
      { path: expect.stringContaining('req-1'), body: { v: 1, decision: 'granted' } }
    ])
    expect(info).toHaveBeenCalledWith(
      '[bots] access request answered',
      expect.objectContaining({ requestId: 'req-1', decision: 'granted', deviceId: 'phone-7' })
    )
    expect(info).toHaveBeenCalledWith(
      '[bots] access request member added',
      expect.objectContaining({ requestId: 'req-1', added: true, deviceId: 'phone-7' })
    )
    info.mockRestore()
  })

  it('adds no one when a Decline elsewhere closed the request first', async () => {
    const { cloud } = fakeAccessCloud([makeAccessRequest()], {
      decide: { ok: false, status: 409, error: 'expired' }
    })
    const host = hostWith(slackBot, cloud)
    vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(
      await decideHostAccessRequest(host.deps, { requestId: 'req-1', decision: 'granted' }, null)
    ).toEqual({ ok: false, error: 'expired' })
    expect(host.updateBot).not.toHaveBeenCalled()
    expect(host.saved().members).toEqual([])
  })

  it('reports a granted request whose add failed, and a retry after a restart adds from cloud state', async () => {
    const { cloud, decisions } = fakeAccessCloud([makeAccessRequest()])
    const host = hostWith(slackBot, cloud)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    host.updateBot.mockRejectedValueOnce(new Error('disk full'))
    const grant = { requestId: 'req-1', decision: 'granted' } as const

    expect(await decideHostAccessRequest(host.deps, grant, null)).toEqual({
      ok: false,
      error: 'granted_not_added'
    })
    expect(host.saved().members).toEqual([])

    // A fresh host holds nothing from before; the cloud still lists the grant as not taken.
    const restarted = hostWith(slackBot, cloud)
    expect(await decideHostAccessRequest(restarted.deps, grant, null)).toEqual({
      ok: true,
      value: undefined
    })
    expect(restarted.saved().members).toEqual([
      { id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T1' }
    ])
    expect(decisions).toHaveLength(1)
    // A Decline cannot reopen a grant.
    expect(
      await decideHostAccessRequest(restarted.deps, { ...grant, decision: 'declined' }, null)
    ).toEqual({ ok: false, error: 'expired' })
  })

  it('finishes a grant whose add failed on the next list, and logs it as a recovery', async () => {
    const { cloud, decisions } = fakeAccessCloud([makeAccessRequest()])
    const host = hostWith(slackBot, cloud)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    host.updateBot.mockRejectedValueOnce(new Error('disk full'))
    await decideHostAccessRequest(host.deps, { requestId: 'req-1', decision: 'granted' }, null)
    expect(host.saved().members).toEqual([])

    expect(await listHostAccessRequests(host.deps)).toEqual({ ok: true, value: [] })
    expect(host.saved().members).toEqual([
      { id: 'U9', name: 'Dana Kim', source: 'slack', workspaceId: 'T1' }
    ])
    expect(info).toHaveBeenCalledWith(
      '[bots] access request member added',
      expect.objectContaining({ requestId: 'req-1', added: true, trigger: 'recovered' })
    )
    // Already listed, so a later list writes nothing until the cloud stops listing the grant.
    await listHostAccessRequests(host.deps)
    expect(host.updateBot).toHaveBeenCalledTimes(2)
    expect(decisions).toHaveLength(1)
    info.mockRestore()
  })

  it('refuses a grant to a full list before the cloud records it', async () => {
    const full = makeTestBot({
      slack: { appId: 'A1', teamId: 'T1' },
      members: Array.from({ length: BOT_MAX_MEMBERS }, (_, index) => ({
        id: `U${index + 100}`,
        name: `Member ${index}`,
        source: 'slack' as const
      }))
    })
    const { cloud, decisions } = fakeAccessCloud([makeAccessRequest()])
    const host = hostWith(full, cloud)

    expect(
      await decideHostAccessRequest(host.deps, { requestId: 'req-1', decision: 'granted' }, null)
    ).toEqual({ ok: false, error: 'full' })
    expect(decisions).toEqual([])
    expect(host.updateBot).not.toHaveBeenCalled()
  })

  it('declines without touching the bot', async () => {
    const { cloud, decisions } = fakeAccessCloud([makeAccessRequest()])
    const host = hostWith(slackBot, cloud)
    vi.spyOn(console, 'info').mockImplementation(() => {})

    await decideHostAccessRequest(host.deps, { requestId: 'req-1', decision: 'declined' }, null)

    expect(host.updateBot).not.toHaveBeenCalled()
    expect(decisions).toHaveLength(1)
  })

  it('refuses a request no longer waiting or not for a bot here, and adds no one', async () => {
    const { cloud, decisions } = fakeAccessCloud([
      makeAccessRequest({ requestId: 'req-2', botId: 'elsewhere' })
    ])
    const host = hostWith(slackBot, cloud)

    for (const requestId of ['req-1', 'req-2']) {
      expect(
        await decideHostAccessRequest(host.deps, { requestId, decision: 'granted' }, null)
      ).toEqual({ ok: false, error: 'expired' })
    }
    expect(host.updateBot).not.toHaveBeenCalled()
    expect(decisions).toEqual([])
  })

  it('answers signed out on a host with no Orca account', async () => {
    expect(await listHostAccessRequests(hostWith(slackBot, null).deps)).toEqual({
      ok: false,
      error: 'signed_out'
    })
  })

  it("leaves the token unspent on a host that does not have the link's bot", async () => {
    const { cloud, call } = fakeAccessCloud([makeAccessRequest()])
    const token = 'a'.repeat(43)

    expect(
      await redeemHostAccessRequest(hostWith(slackBot, cloud).deps, { botId: 'elsewhere', token })
    ).toEqual({ kind: 'not-here' })
    expect(call).not.toHaveBeenCalled()

    // A link naming no bot: the cloud matches the token's bot against this host's.
    const elsewhere = fakeAccessCloud([], { redeem: { ok: false, status: 409, error: 'not_here' } })
    expect(
      await redeemHostAccessRequest(hostWith(slackBot, elsewhere.cloud).deps, { token })
    ).toEqual({ kind: 'not-here' })
  })

  it("redeems an owner's link to its bot, and leaves it for the next host when signed out", async () => {
    const ok = fakeAccessCloud([makeAccessRequest()])
    const notOwner = fakeAccessCloud([], { redeem: { ok: false, status: 403, error: 'not_owner' } })
    const expired = fakeAccessCloud([], { redeem: { ok: false, status: 410, error: 'expired' } })
    const unreachable = fakeAccessCloud([], { redeem: { ok: false, status: null, error: null } })
    const link = { token: 'a'.repeat(43) }

    expect(await redeemHostAccessRequest(hostWith(slackBot, ok.cloud).deps, link)).toEqual({
      kind: 'redeemed',
      botId: 'bot-1',
      request: makeAccessRequest()
    })
    // This host's bots, so the cloud leaves another bot's token unspent.
    expect(ok.call).toHaveBeenCalledWith(
      expect.stringContaining('/redeem'),
      { v: 1, token: link.token, botIds: ['bot-1'] },
      expect.anything()
    )
    expect(await redeemHostAccessRequest(hostWith(slackBot, notOwner.cloud).deps, link)).toEqual({
      kind: 'not-owner'
    })
    expect(await redeemHostAccessRequest(hostWith(slackBot, expired.cloud).deps, link)).toEqual({
      kind: 'expired'
    })
    expect(await redeemHostAccessRequest(hostWith(slackBot, unreachable.cloud).deps, link)).toEqual(
      { kind: 'failed' }
    )
    expect(await redeemHostAccessRequest(hostWith(slackBot, null).deps, link)).toEqual({
      kind: 'unsupported'
    })
  })
})
