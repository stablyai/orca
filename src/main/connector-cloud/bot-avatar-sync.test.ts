import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { BotAvatarSync } from './bot-avatar-sync'

type SyncedBot = Pick<Bot, 'id' | 'avatar' | 'slack' | 'github'>

function harness(bots: Partial<SyncedBot>[]) {
  const call = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const list: SyncedBot[] = bots.map((bot) => ({
    id: 'bot-1',
    avatar: null,
    slack: null,
    github: null,
    ...bot
  }))
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => list,
      readAvatarImage: async () => Buffer.from('png')
    },
    cloud: () => ({ call })
  })
  return { sync, call, list }
}

const SLACK = { appId: 'A1', teamId: 'T1' }

describe('BotAvatarSync', () => {
  it("sends a Slack bot's picture once per change, and nothing for a bot without an app", async () => {
    const { sync, call, list } = harness([
      { id: 'bot-1', avatar: 'mascot:K2', slack: SLACK },
      { id: 'bot-2', avatar: 'mascot:A1', slack: null },
      { id: 'bot-3', avatar: '🦊', slack: SLACK }
    ])
    sync.changed()
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call).toHaveBeenCalledWith(
      '/v1/connector/bots/bot-1/avatar',
      { v: 1, kind: 'mascot', id: 'K2' },
      expect.anything(),
      { method: 'PUT' }
    )

    list[0] = { id: 'bot-1', slack: SLACK, github: null, avatar: 'upload:0123456789abcdef' }
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls[1]?.[1]).toEqual({
      v: 1,
      kind: 'upload',
      version: '0123456789abcdef',
      png: Buffer.from('png').toString('base64')
    })
  })

  it('sends the picture of a bot linked only to GitHub, for the cloud’s pages', async () => {
    const { sync, call } = harness([
      { id: 'bot-1', avatar: 'mascot:K2', github: {} },
      { id: 'bot-2', avatar: 'mascot:A1' }
    ])
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(call).toHaveBeenCalledWith(
      '/v1/connector/bots/bot-1/avatar',
      { v: 1, kind: 'mascot', id: 'K2' },
      expect.anything(),
      { method: 'PUT' }
    )
  })

  it('sends again after a failed send', async () => {
    const { sync, call } = harness([{ avatar: 'mascot:K2', slack: SLACK }])
    call.mockResolvedValueOnce({ ok: false, status: null })
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  })

  it('sends a picture chosen while a refused one was on its way', async () => {
    const { sync, call, list } = harness([{ avatar: 'mascot:K2', github: {} }])
    let answer!: (value: unknown) => void
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    sync.changed()
    list[0] = { id: 'bot-1', slack: null, github: {}, avatar: 'mascot:A1' }
    sync.changed()
    answer({ ok: false, status: 404, error: 'unknown_bot', retryAfterMs: null })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls[1]?.[1]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
  })

  it('sends one picture at a time per bot, ending on the latest', async () => {
    const { sync, call, list } = harness([{ avatar: 'mascot:K2', slack: SLACK }])
    let answer!: (value: unknown) => void
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    sync.changed()
    list[0] = { id: 'bot-1', slack: SLACK, github: null, avatar: 'mascot:A1' }
    sync.changed()
    expect(call).toHaveBeenCalledTimes(1)
    answer({ ok: true, value: undefined })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls[1]?.[1]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
  })
})
