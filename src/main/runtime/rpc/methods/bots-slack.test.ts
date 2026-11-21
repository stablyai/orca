import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BotSlackGrant } from '../../../../shared/rpc-contract/bots-connector-setup-params'
import type { RpcContext } from '../core'
import { BOT_SLACK_METHODS, nextSlackApps } from './bots-slack'

const mocks = vi.hoisted(() => {
  const account: string | null = 'acct-1'
  return {
    features: new Set<string>(),
    list: vi.fn(),
    call: vi.fn(),
    update: vi.fn(),
    held: new Array<string>(),
    account
  }
})

// The bot an update function is given, with one Slack workspace.
const inT1 = { slack: { appId: 'A1', teamId: 'T1' } }
const createdIn = (teamId: string) => ({
  ok: true,
  value: { state: 'created', appId: teamId === 'T2' ? 'A2' : 'A1', teamId }
})
const editedFrom = (bot: Parameters<typeof nextSlackApps>[0]): unknown => {
  const [, edit] = mocks.update.mock.lastCall ?? []
  return typeof edit === 'function' ? edit(bot) : edit
}

function invoke(name: string, params: unknown): Promise<unknown> {
  const method = BOT_SLACK_METHODS.find((entry) => entry.name === name)
  const context = {
    runtime: {
      bots: { list: mocks.list, update: mocks.update },
      getConnectorCloud: () => ({
        call: mocks.call,
        cloudFeatures: () => mocks.features,
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
  mocks.list.mockReset().mockReturnValue([
    {
      id: 'bot-1',
      slack: inT1.slack,
      slackApps: [inT1.slack, { appId: 'A2', teamId: 'T2' }]
    }
  ])
  mocks.call.mockReset()
  mocks.update.mockReset().mockResolvedValue({})
  mocks.held.length = 0
  mocks.account = 'acct-1'
  mocks.features.clear()
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
    mocks.call.mockResolvedValueOnce(createdIn('T2'))
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

  it.each([
    'not_installed',
    'app_not_found',
    'invalid_app_id',
    'token_revoked',
    'account_inactive'
  ])('forgets only the requested workspace when removal reports %s', async (error) => {
    mocks.call.mockResolvedValueOnce(createdIn('T1'))
    mocks.call.mockResolvedValueOnce({ ok: false, status: 409, error })
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: true,
      value: undefined
    })
    expect(
      editedFrom({
        slack: inT1.slack,
        slackApps: [inT1.slack, { appId: 'A2', teamId: 'T2' }]
      })
    ).toEqual({ slackApps: [{ appId: 'A2', teamId: 'T2' }] })
  })

  it.each(['cloud_unreachable', 'signed_out', 'slack_unavailable', 'invalid_auth'])(
    'keeps the local app when removal cannot confirm it stopped: %s',
    async (error) => {
      mocks.call.mockResolvedValueOnce(createdIn('T1'))
      mocks.call.mockResolvedValueOnce({ ok: false, status: 503, error })
      expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
        ok: false,
        error
      })
      expect(mocks.update).not.toHaveBeenCalled()
    }
  )

  it('keeps the current account’s apps when removal answers after an account switch', async () => {
    mocks.call.mockResolvedValueOnce(createdIn('T1'))
    mocks.call.mockImplementationOnce(async () => {
      mocks.account = 'acct-2'
      return { ok: true, value: undefined }
    })
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: false,
      error: 'account_changed'
    })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each([
    { state: 'not_created' } as const,
    {
      state: 'installed',
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'U1',
      installerUserId: 'U2'
    } as const
  ])(
    'forgets an absent workspace without disconnecting another on an older service: %o',
    async (state) => {
      mocks.call.mockResolvedValueOnce({ ok: true, value: state })
      expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T2' })).toEqual({
        ok: true,
        value: undefined
      })
      expect(mocks.call.mock.calls.map((call) => call[3]?.method)).toEqual(['GET'])
      expect(
        editedFrom({
          slack: inT1.slack,
          slackApps: [inT1.slack, { appId: 'A2', teamId: 'T2' }]
        })
      ).toEqual({ slackApps: [inT1.slack] })
    }
  )

  it('leaves an already removed workspace unchanged inside the serialized edit', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, value: { state: 'not_created' } })
    await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T2' })
    expect(editedFrom(inT1)).toBeNull()
  })

  it('keeps an app replaced while an absent-workspace check was in flight', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, value: { state: 'not_created' } })
    await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })
    expect(editedFrom({ slack: { teamId: 'T1', appId: 'A-new' } })).toBeNull()
  })

  it('removes the workspace when Cloud has a newer app than the saved record', async () => {
    mocks.call.mockResolvedValueOnce({
      ok: true,
      value: {
        state: 'installed',
        teamId: 'T1',
        appId: 'A-new',
        botUserId: 'U1',
        installerUserId: 'U2'
      }
    })
    mocks.call.mockResolvedValueOnce({ ok: true, value: undefined })
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: true,
      value: undefined
    })
    expect(mocks.call.mock.calls.map((call) => call[3]?.method)).toEqual(['GET', 'DELETE'])
    expect(editedFrom(inT1)).toEqual({ slackApps: [] })
    expect(editedFrom({ slack: { teamId: 'T1', appId: 'A-new' } })).toBeNull()
  })

  it('removes the workspace even when its app was never saved locally', async () => {
    mocks.list.mockReturnValue([{ id: 'bot-1', slack: null }])
    mocks.call.mockResolvedValueOnce(createdIn('T1'))
    mocks.call.mockResolvedValueOnce({ ok: true, value: undefined })
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: true,
      value: undefined
    })
    expect(mocks.call.mock.calls.map((call) => call[3]?.method)).toEqual(['GET', 'DELETE'])
    expect(editedFrom({ slack: null })).toBeNull()
  })

  it('does not send DELETE as a different account after the workspace check', async () => {
    mocks.call.mockImplementationOnce(async () => {
      mocks.account = 'acct-2'
      return createdIn('T1')
    })
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: false,
      error: 'account_changed'
    })
    expect(mocks.call.mock.calls.map((call) => call[3]?.method)).toEqual(['GET'])
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('reports a failed local removal save and allows a retry', async () => {
    mocks.call.mockResolvedValue({ ok: true, value: { state: 'not_created' } })
    mocks.update.mockRejectedValueOnce(new Error('home_read_only'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
        ok: false,
        error: 'cloud_error'
      })
      expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
        ok: true,
        value: undefined
      })
      expect(editedFrom(inT1)).toEqual({ slackApps: [] })
    } finally {
      log.mockRestore()
    }
  })

  it('keeps a completed Cloud removal successful if the bot was deleted meanwhile', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, value: { state: 'not_created' } })
    mocks.update.mockRejectedValueOnce(new Error('bot_not_found'))
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: true,
      value: undefined
    })
  })

  it('uses the advertised workspace DELETE directly when the service can scope it', async () => {
    mocks.features.add('slack.teams')
    mocks.call.mockResolvedValueOnce({ ok: true, value: undefined })
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: true,
      value: undefined
    })
    expect(mocks.call.mock.calls.map((call) => call[3]?.method)).toEqual(['DELETE'])
    expect(editedFrom(inT1)).toEqual({ slackApps: [] })
  })

  it('reports a preserved replacement instead of claiming the saved connection was removed', async () => {
    mocks.features.add('slack.teams')
    mocks.call.mockResolvedValueOnce({ ok: true, value: undefined })
    mocks.update.mockImplementationOnce(async (_id, edit) =>
      edit({ slack: { appId: 'A-new', teamId: 'T1' } })
    )
    expect(await invoke('bots.slack.remove', { botId: 'bot-1', teamId: 'T1' })).toEqual({
      ok: false,
      error: 'cloud_error'
    })
    expect(editedFrom({ slack: { appId: 'A-new', teamId: 'T1' } })).toBeNull()
  })

  it('takes nothing that is not a configuration refresh token', () => {
    expect(BotSlackGrant.safeParse({ refreshToken: 'xoxb-bot-token' }).success).toBe(false)
  })
})
