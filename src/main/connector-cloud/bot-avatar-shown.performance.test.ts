// Guards PR #47381: each /poll answer flushes failed shown.json writes; while a write is stuck, repeated
// flushes must not stack a write per bot per answer.
import { expect, it } from 'vitest'
import type { BotSlackIconShown } from '../bots/bot-slack-icon-store'
import { BotAvatarShown } from './bot-avatar-shown'

// Write jobs run, counted where each runs: its check that the bot still exists.
async function jobsAfterFlushes(bots: number, answers: number): Promise<number> {
  let failing = true
  let jobs = 0
  let release = (): void => {}
  const stuck = new Promise<void>((resolve) => (release = resolve))
  const shown = new BotAvatarShown(
    {
      shown: async () => null,
      markShown: async (_botId: string, _value: BotSlackIconShown | null) => {
        if (failing) {
          throw new Error('disk full')
        }
        await stuck
      }
    },
    () => {
      jobs += 1
      return true
    }
  )
  const drawing = { account: 'a1b2', mascot: 'G1' }
  for (let bot = 0; bot < bots; bot += 1) {
    await shown.mark(`bot-${bot}`, drawing).catch(() => {})
  }
  failing = false
  jobs = 0
  const flushes = Array.from({ length: answers }, () => shown.flush())
  release()
  await Promise.all(flushes)
  return jobs
}

it('runs one write job per failed record however many poll answers flush while a write is stuck', async () => {
  expect(await jobsAfterFlushes(10, 10)).toBe(10)
  expect(await jobsAfterFlushes(10, 100)).toBe(10)
  expect(await jobsAfterFlushes(100, 100)).toBe(100)
})

// Flushes still pending, counted where each starts: the one flush a stuck write holds is joined, not repeated.
async function flushesWhileStuck(answers: number): Promise<number> {
  let failing = true
  let release = (): void => {}
  const stuck = new Promise<void>((resolve) => (release = resolve))
  const shown = new BotAvatarShown(
    {
      shown: async () => null,
      markShown: async () => {
        if (failing) {
          throw new Error('disk full')
        }
        await stuck
      }
    },
    () => true
  )
  for (let bot = 0; bot < 10; bot += 1) {
    await shown.mark(`bot-${bot}`, { account: 'a1b2', mascot: 'G1' }).catch(() => {})
  }
  failing = false
  const pending = new Set(Array.from({ length: answers }, () => shown.flush()))
  release()
  await Promise.all(pending)
  return pending.size
}

it('holds one flush while a write is stuck, however many poll answers ask', async () => {
  expect(await flushesWhileStuck(10)).toBe(1)
  expect(await flushesWhileStuck(100)).toBe(1)
})
