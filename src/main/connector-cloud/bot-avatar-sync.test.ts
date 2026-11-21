import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { BotAvatarSync } from './bot-avatar-sync'

type SyncedBot = Pick<Bot, 'id' | 'avatar' | 'slack' | 'github'>

function harness(bots: Partial<SyncedBot>[]) {
  const state = { enabled: true }
  const call = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const list: SyncedBot[] = bots.map((bot) => ({
    id: 'bot-1',
    avatar: null,
    slack: null,
    github: null,
    ...bot
  }))
  const reads = { count: 0 }
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => state.enabled,
      list: () => {
        reads.count++
        return list
      },
      readAvatarImage: async () => Buffer.from('png')
    },
    cloud: () => ({ call })
  })
  return { sync, call, list, reads, state }
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
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/v1/connector/bots/bot-1/avatar',
      { v: 1, kind: 'mascot', id: 'K2' },
      expect.anything(),
      { method: 'PUT' }
    )
    list[0] = { id: 'bot-1', slack: null, github: {}, avatar: 'mascot:A1' }
    sync.changed()
    answer({ ok: false, status: 404, error: 'unknown_bot', retryAfterMs: null })
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(call.mock.calls[1]?.[1]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
  })

  it('sends at most four pictures at once and reads the roster once per pass', async () => {
    const { sync, call, reads } = harness(
      Array.from({ length: 10 }, (_, index) => ({
        id: `bot-${index}`,
        avatar: 'mascot:K2',
        slack: SLACK
      }))
    )
    const release: (() => void)[] = []
    call.mockImplementation(
      () => new Promise((resolve) => release.push(() => resolve({ ok: true, value: undefined })))
    )
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(4))
    while (release.length > 0 || call.mock.calls.length < 10) {
      release.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(call).toHaveBeenCalledTimes(10)
    expect(reads.count).toBe(1)
  })

  it('sends the restored picture when a bot returns to its last sent one mid-send', async () => {
    const { sync, call, list } = harness([{ id: 'bot-1', avatar: 'mascot:K2', slack: SLACK }])
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const release: (() => void)[] = []
    call.mockImplementationOnce(
      () => new Promise((resolve) => release.push(() => resolve({ ok: true, value: undefined })))
    )
    list[0] = { ...list[0]!, avatar: 'mascot:A1' }
    sync.changed()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    list[0] = { ...list[0]!, avatar: 'mascot:K2' }
    sync.changed()
    release[0]!()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3))
    expect(call.mock.calls[2]?.[1]).toEqual({ v: 1, kind: 'mascot', id: 'K2' })
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

  it('sends a picture chosen while bots were off and its send was in flight, once bots are on', async () => {
    vi.useFakeTimers()
    try {
      const { sync, call, list, state } = harness([{ avatar: 'mascot:K2', slack: SLACK }])
      let answer!: (value: unknown) => void
      call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      sync.changed()
      state.enabled = false
      list[0] = { id: 'bot-1', slack: SLACK, github: null, avatar: 'mascot:A1' }
      sync.changed()
      answer({ ok: true, value: undefined })
      await vi.advanceTimersByTimeAsync(0)
      state.enabled = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(call).toHaveBeenCalledTimes(2)
      expect(call.mock.calls[1]?.[1]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a picture changed during a send pending across a retry that finds bots still off', async () => {
    vi.useFakeTimers()
    try {
      const { sync, call, list, state } = harness([{ avatar: 'mascot:K2', slack: SLACK }])
      let answer!: (value: unknown) => void
      call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      sync.changed()
      state.enabled = false
      list[0] = { id: 'bot-1', slack: SLACK, github: null, avatar: 'mascot:A1' }
      sync.changed()
      answer({ ok: true, value: undefined })
      await vi.advanceTimersByTimeAsync(60_000)
      state.enabled = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(call).toHaveBeenCalledTimes(2)
      expect(call.mock.calls[1]?.[1]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
    } finally {
      vi.useRealTimers()
    }
  })
})
