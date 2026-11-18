import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BotSlackGrant } from '../../../../shared/rpc-contract/bots-connector-setup-params'
import type { RpcContext } from '../core'
import { BOT_SLACK_METHODS, nextSlackApps } from './bots-slack'

const mocks = vi.hoisted(() => {
  const account: string | null = 'acct-1'
  return { call: vi.fn(), update: vi.fn(), held: new Array<string>(), account }
})

// The bot an update function is given, with one Slack workspace.
const inT1 = { slack: { appId: 'A1', teamId: 'T1' } }
const editedFrom = (bot: Parameters<typeof nextSlackApps>[0]): unknown => {
  const [, edit] = mocks.update.mock.lastCall ?? []
  return typeof edit === 'function' ? edit(bot) : edit
}

function invoke(name: string, params: unknown): Promise<unknown> {
  const method = BOT_SLACK_METHODS.find((entry) => entry.name === name)
  const context = {
    runtime: {
      bots: { update: mocks.update },
      getConnectorCloud: () => ({
        call: mocks.call,
        signedInAccount: () => mocks.account,
        withConnection: async <T>(run: () => Promise<T>): Promise<T> => {
          mocks.held.push('held')
          const result = await run()
          mocks.held.push('released')
          return result
        }
      })
    }
  }
  return Promise.resolve(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the runtime parts faked above, and its params are the test's own.
    method?.handler(params as never, context as unknown as RpcContext)
  )
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.update.mockReset().mockResolvedValue({})
  mocks.held.length = 0
  mocks.account = 'acct-1'
})

describe('bots.slack', () => {
  it('records the app on the bot only once the cloud set it up', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: true,
      value: { appId: 'A1', authorizeUrl: 'https://slack.com/oauth/v2/authorize' }
    })
    mocks.update.mockImplementationOnce(async () => {
      mocks.held.push('recorded')
      return {}
    })
    await invoke('bots.slack.setUpApp', { botId: 'bot-1', teamId: 'T1' })
    // The cloud knows a bot only from a hello, so the connection is held through set-up and record.
    expect(mocks.held).toEqual(['held', 'recorded', 'released'])
    expect(mocks.update).toHaveBeenCalledWith('bot-1', expect.any(Function))
    expect(editedFrom({ slack: null })).toEqual({ slackApps: [{ appId: 'A1', teamId: 'T1' }] })

    mocks.update.mockClear()
    mocks.call.mockResolvedValueOnce({ ok: false, status: 400, error: 'grant_expired' })
    expect(await invoke('bots.slack.setUpApp', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: false,
      error: 'grant_expired'
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('does not record an app the cloud set up for an account the host has since left', async () => {
    mocks.call.mockImplementationOnce(async () => {
      mocks.account = 'acct-2'
      return {
        ok: true,
        value: { appId: 'A1', authorizeUrl: 'https://slack.com/oauth/v2/authorize' }
      }
    })
    expect(await invoke('bots.slack.setUpApp', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: false,
      error: 'account_changed'
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('records a handed-off app as the host’s cloud reads it, and nothing it does not hold', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: true,
      value: { state: 'created', teamId: 'T1', appId: 'A-cloud' }
    })
    await invoke('bots.slack.adoptApp', { botId: 'bot-1', teamId: 'T1' })
    expect(editedFrom({ slack: null })).toEqual({
      slackApps: [{ appId: 'A-cloud', teamId: 'T1' }]
    })

    mocks.update.mockClear()
    mocks.call.mockResolvedValueOnce({ ok: true, value: { state: 'not_created' } })
    expect(await invoke('bots.slack.adoptApp', { botId: 'bot-1', teamId: 'T1' })).toMatchObject({
      ok: false
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('clears the bot’s app once it is removed from Slack, in one workspace or all', async () => {
    const both = { slackApps: [...nextSlackApps(inT1, { set: { appId: 'A2', teamId: 'T2' } })] }
    mocks.call.mockResolvedValueOnce({ ok: true, value: undefined })
    await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T2' })
    expect(mocks.call.mock.lastCall?.[0]).toMatch(/\/slack\?team=T2$/)
    expect(editedFrom({ slack: both.slackApps[0], ...both })).toEqual({ slackApps: [inT1.slack] })

    mocks.call.mockResolvedValueOnce({ ok: true, value: undefined })
    await invoke('bots.slack.remove', { botId: 'bot-1' })
    expect(mocks.call.mock.lastCall?.[0]).toMatch(/\/slack$/)
    expect(editedFrom({ slack: both.slackApps[0], ...both })).toEqual({ slackApps: [] })
  })

  it('adds a second workspace after the first, and replaces a workspace’s app in place', () => {
    const second = nextSlackApps(inT1, { set: { appId: 'A2', teamId: 'T2' } })
    expect(second).toEqual([inT1.slack, { appId: 'A2', teamId: 'T2' }])
    expect(
      nextSlackApps(
        { slack: second[0] ?? null, slackApps: second },
        { set: { appId: 'A9', teamId: 'T1' } }
      )
    ).toEqual([
      { appId: 'A9', teamId: 'T1' },
      { appId: 'A2', teamId: 'T2' }
    ])
  })

  it('takes nothing that is not a configuration refresh token', () => {
    expect(BotSlackGrant.safeParse({ refreshToken: 'xoxb-bot-token' }).success).toBe(false)
  })
})
