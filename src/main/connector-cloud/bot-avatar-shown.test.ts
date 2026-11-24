import { expect, it } from 'vitest'
import type { BotSlackIconShown } from '../bots/bot-slack-icon-store'
import { BotAvatarShown } from './bot-avatar-shown'

it('writes the kept-drawing record again after a failed write, so a restart still keeps the drawing', async () => {
  let onDisk: BotSlackIconShown | null = null
  let failNext = true
  const shown = new BotAvatarShown(
    {
      shown: async () => onDisk,
      markShown: async (_botId, value) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        onDisk = value
      }
    },
    () => true
  )
  const drawing = { account: 'a1b2', mascot: 'G1' }
  await expect(shown.mark('bot-1', drawing)).rejects.toThrow('disk full')
  // The same value taken again: the earlier write failed, so this one is written.
  await shown.mark('bot-1', drawing)
  expect(onDisk).toEqual(drawing)
})
