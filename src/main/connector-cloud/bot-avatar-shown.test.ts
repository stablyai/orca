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

it('writes a record whose write failed again on its own, with no other upload', async () => {
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
  await shown.flush()
  expect(onDisk).toEqual(drawing)
})

it('never lets a slower retry put an older record back over a newer one', async () => {
  const onDisk = new Map<string, BotSlackIconShown | null>()
  let failNext = true
  let release = (): void => {}
  let hold: Promise<void> | null = null
  const shown = new BotAvatarShown(
    {
      shown: async (botId) => onDisk.get(botId) ?? null,
      markShown: async (botId, value) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        // Only the retry's write is slow.
        const slow = hold
        hold = null
        await slow
        onDisk.set(botId, value)
      }
    },
    () => true
  )
  const older = { account: 'a1b2', mascot: 'A1' }
  const newer = { account: 'a1b2', mascot: 'G1' }
  await expect(shown.mark('bot-1', older)).rejects.toThrow('disk full')
  hold = new Promise((resolve) => (release = resolve))
  const retry = shown.flush()
  const marked = shown.mark('bot-1', newer)
  // The newer record's write gets every chance to land before the slow retry finishes.
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  await Promise.all([retry, marked])
  expect(onDisk.get('bot-1')).toEqual(newer)
})

it('keeps retrying other bots while one record keeps failing', async () => {
  const onDisk = new Map<string, BotSlackIconShown | null>()
  let bFails = 1
  const shown = new BotAvatarShown(
    {
      shown: async () => null,
      markShown: async (botId, value) => {
        if (botId === 'bot-a' || (botId === 'bot-b' && bFails-- > 0)) {
          throw new Error('unwritable')
        }
        onDisk.set(botId, value)
      }
    },
    () => true
  )
  const drawing = { account: 'a1b2', mascot: 'G1' }
  await expect(shown.mark('bot-a', drawing)).rejects.toThrow()
  await expect(shown.mark('bot-b', drawing)).rejects.toThrow()
  await shown.flush()
  expect(onDisk.get('bot-b')).toEqual(drawing)
  expect(onDisk.has('bot-a')).toBe(false)
})
