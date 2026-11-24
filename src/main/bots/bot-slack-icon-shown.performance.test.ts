// Guards PR #47381: each /poll answer may retry failed shown.json saves; a lasting failure, a stuck write,
// and bursts of marks, answers and steps must keep disk attempts and held work bounded by the bots, not by
// the poll's answers.
import { expect, it, vi } from 'vitest'
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

// Saves once a stuck write lets go, after a burst of marks per bot, poll answers and real steps behind it;
// each bot still ends with its latest record on disk.
async function savesAfterStuckBurst(bots: number, burst: number): Promise<number> {
  let saves = 0
  let release = (): void => {}
  const stuck = new Promise<void>((resolve) => (release = resolve))
  const onDisk = new Map<string, string | undefined>()
  const records = new BotSlackIconShownRecords({
    read: async () => null,
    write: async (botId, shown) => {
      saves += 1
      await stuck
      onDisk.set(botId, shown?.mascot)
    },
    exists: () => true
  })
  records.mark('bot-0', { account: 'a1b2', mascot: 'start' })
  // The first save is on its way and stuck before the burst comes.
  await vi.waitFor(() => expect(saves).toBe(1))
  for (let round = 0; round < burst; round += 1) {
    for (let bot = 0; bot < bots; bot += 1) {
      records.mark(`bot-${bot}`, { account: 'a1b2', mascot: `G${round}` })
    }
    records.answered()
    records.stepped()
  }
  release()
  await records.settled()
  for (let bot = 0; bot < bots; bot += 1) {
    expect(onDisk.get(`bot-${bot}`)).toBe(`G${burst - 1}`)
  }
  return saves
}

it('writes each bot at most twice after a stuck write, however long the burst behind it', async () => {
  expect(await savesAfterStuckBurst(10, 10)).toBeLessThanOrEqual(20)
  expect(await savesAfterStuckBurst(10, 100)).toBeLessThanOrEqual(20)
  expect(await savesAfterStuckBurst(100, 100)).toBeLessThanOrEqual(200)
})

// Records visited by poll answers once every failed record has had its answer retry: none, at any count.
async function visitsOnSpentAnswers(bots: number, answers: number): Promise<number> {
  const records = new BotSlackIconShownRecords({
    read: async () => null,
    write: async () => {
      throw new Error('disk full')
    },
    exists: () => true
  })
  for (let bot = 0; bot < bots; bot += 1) {
    records.mark(`bot-${bot}`, { account: 'a1b2', mascot: 'G1' })
  }
  await idle()
  records.answered()
  await idle()
  // Any walk over a set or map (spread, for-of, keys, values, forEach) on the answers counts.
  const walks = [Set.prototype, Map.prototype].flatMap((prototype) =>
    (['keys', 'values', 'entries', 'forEach', Symbol.iterator] as const).map((method) =>
      vi.spyOn(prototype, method)
    )
  )
  const count = (): number => walks.reduce((total, walk) => total + walk.mock.calls.length, 0)
  try {
    // Installing the spies walks a few collections itself.
    const before = count()
    for (let answer = 0; answer < answers; answer += 1) {
      records.answered()
    }
    return count() - before
  } finally {
    walks.forEach((walk) => walk.mockRestore())
  }
}

it('visits no record on poll answers once retries are spent', async () => {
  expect(await visitsOnSpentAnswers(10, 10)).toBe(0)
  expect(await visitsOnSpentAnswers(100, 1000)).toBe(0)
})

// Distinct writer promises over rounds of slow failing saves with a real step during each.
async function writersAcrossSteppedRounds(rounds: number): Promise<number> {
  const writers = new Set<Promise<void>>()
  let left = rounds
  const records = new BotSlackIconShownRecords({
    read: async () => null,
    write: async () => {
      await idle()
      if (left-- > 0) {
        writers.add(records.settled())
      }
      throw new Error('disk full')
    },
    exists: () => true
  })
  records.mark('bot-1', { account: 'a1b2', mascot: 'G1' })
  writers.add(records.settled())
  while (left > 0) {
    await idle()
  }
  await records.settled()
  return writers.size
}

it('keeps one writer however many real steps arrive during slow failing saves', async () => {
  expect(await writersAcrossSteppedRounds(10)).toBe(1)
  expect(await writersAcrossSteppedRounds(100)).toBe(1)
})
