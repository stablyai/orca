// Guards PR #47381: each /poll answer may retry failed shown.json saves; a lasting failure, a stuck write,
// and bursts of marks, answers and steps must keep disk attempts and held work bounded by the bots, not by
// the poll's answers.
import { expect, it } from 'vitest'
import { BotSlackIconShownRecords } from './bot-slack-icon-shown'

const idle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// Save attempts on a disk that keeps failing, over `answers` settled poll answers after the first failures.
async function attemptsOnFailingDisk(bots: number, answers: number): Promise<number> {
  let attempts = 0
  const records = new BotSlackIconShownRecords({
    read: async () => null,
    write: async () => {
      attempts += 1
      throw new Error('disk full')
    },
    exists: () => true
  })
  for (let bot = 0; bot < bots; bot += 1) {
    records.mark(`bot-${bot}`, { account: 'a1b2', mascot: 'G1' })
  }
  await idle()
  attempts = 0
  for (let answer = 0; answer < answers; answer += 1) {
    records.answered()
    await idle()
  }
  return attempts
}

it('retries each failed record once however many poll answers come', async () => {
  expect(await attemptsOnFailingDisk(10, 10)).toBe(10)
  expect(await attemptsOnFailingDisk(10, 100)).toBe(10)
  expect(await attemptsOnFailingDisk(100, 100)).toBe(100)
})

// Saves once a stuck write lets go, after a burst of marks per bot, poll answers and real steps meanwhile.
async function savesAfterStuckBurst(bots: number, burst: number): Promise<number> {
  let saves = 0
  let release = (): void => {}
  const stuck = new Promise<void>((resolve) => (release = resolve))
  const records = new BotSlackIconShownRecords({
    read: async () => null,
    write: async () => {
      saves += 1
      await stuck
    },
    exists: () => true
  })
  for (let round = 0; round < burst; round += 1) {
    for (let bot = 0; bot < bots; bot += 1) {
      records.mark(`bot-${bot}`, { account: 'a1b2', mascot: `G${round % 2}` })
    }
    records.answered()
    records.stepped()
  }
  release()
  await records.settled()
  return saves
}

it('writes each bot at most twice after a stuck write, however long the burst behind it', async () => {
  expect(await savesAfterStuckBurst(10, 10)).toBeLessThanOrEqual(20)
  expect(await savesAfterStuckBurst(10, 100)).toBeLessThanOrEqual(20)
  expect(await savesAfterStuckBurst(100, 100)).toBeLessThanOrEqual(200)
})
