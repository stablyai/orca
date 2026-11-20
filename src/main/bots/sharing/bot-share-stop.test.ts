import { expect, it, vi } from 'vitest'
import { stopBotShare } from './bot-share-stop'

it('revokes the link even when the share list fails, keeping the picks', async () => {
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
})
