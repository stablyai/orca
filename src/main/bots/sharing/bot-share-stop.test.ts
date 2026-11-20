import { expect, it, vi } from 'vitest'
import { stopBotShare } from './bot-share-stop'

it('revokes the link and preserves the picks when the share list fails', async () => {
  const revokeShare = vi.fn(async () => ({ status: 'ok' as const, value: true }))
  const forget = vi.fn(async () => undefined)
  const result = await stopBotShare(
    {
      client: {
        listShares: async () => {
          throw new Error('503')
        },
        revokeShare
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only forget is called.
      picks: { forget } as never
    },
    'share-1',
    'bot-1'
  )
  expect(revokeShare).toHaveBeenCalledWith('share-1')
  expect(result).toEqual({ status: 'ok', value: true })
  expect(forget).not.toHaveBeenCalled()
})

it.each([
  { name: 'bot-bot1', forgets: true },
  { name: 'bot-otherbot', forgets: false },
  { name: undefined, forgets: false }
])('forgets picks only for a confirmed owner ($name)', async ({ name, forgets }) => {
  const forget = vi.fn(async () => undefined)
  const result = await stopBotShare(
    {
      client: {
        listShares: async () => ({
          status: 'ok',
          value: name
            ? [{ id: 'share-1', name, url: '', packageId: '', createdAt: '', canonical: true }]
            : []
        }),
        revokeShare: async () => ({ status: 'ok', value: true })
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only forget is called.
      picks: { forget } as never
    },
    'share-1',
    'bot-1'
  )
  expect(result).toEqual({ status: 'ok', value: true })
  if (forgets) {
    expect(forget).toHaveBeenCalledWith('bot-1')
  } else {
    expect(forget).not.toHaveBeenCalled()
  }
})
