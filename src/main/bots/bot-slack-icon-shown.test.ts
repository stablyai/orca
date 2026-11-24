import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { localBotHomeFilesystem } from './bot-home'
import { BotSlackIcons } from './bot-slack-icon-store'
import {
  BOT_SLACK_ICON_SHOWN_SETTLE_MS,
  type BotSlackIconShown,
  BotSlackIconShownRecords
} from './bot-slack-icon-shown'

type Disk = {
  records: BotSlackIconShownRecords
  onDisk: Map<string, BotSlackIconShown | null>
  attempts: () => number
  fail: (failing: boolean) => void
  hold: () => () => void
}

function disk(exists: (botId: string) => boolean = () => true): Disk {
  const onDisk = new Map<string, BotSlackIconShown | null>()
  let attempts = 0
  let failing = false
  let held: Promise<void> | null = null
  const records = new BotSlackIconShownRecords({
    read: async (botId) => onDisk.get(botId) ?? null,
    write: async (botId, shown) => {
      attempts += 1
      if (held) {
        await held
      }
      if (failing) {
        throw new Error('disk full')
      }
      if (exists(botId)) {
        onDisk.set(botId, shown)
      }
    },
    exists
  })
  return {
    records,
    onDisk,
    attempts: () => attempts,
    fail: (value) => (failing = value),
    hold: () => {
      let release = (): void => {}
      held = new Promise<void>((resolve) => (release = resolve))
      return () => {
        held = null
        release()
      }
    }
  }
}

const idle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const G1 = { account: 'a1b2', mascot: 'G1' }
const G2 = { account: 'a1b2', mascot: 'G2' }

it('saves a record whose write failed on the next poll answer, with no other upload', async () => {
  const { records, onDisk, fail } = disk()
  fail(true)
  records.mark('bot-1', G1)
  await idle()
  fail(false)
  records.answered()
  await records.settled()
  expect(onDisk.get('bot-1')).toEqual(G1)
})

it('tries a lasting failure once on poll answers, then on each real step and at quit', async () => {
  const { records, attempts, fail, onDisk } = disk()
  fail(true)
  records.mark('bot-1', G1)
  await idle()
  const answer = async (): Promise<void> => {
    records.answered()
    await idle()
  }
  for (let index = 0; index < 50; index += 1) {
    await answer()
  }
  expect(attempts()).toBe(2)
  records.stepped()
  await answer()
  await answer()
  expect(attempts()).toBe(4)
  fail(false)
  await records.settled()
  expect(onDisk.get('bot-1')).toEqual(G1)
})

it('never lets an older record land after a newer one, and the caller never waits on the disk', async () => {
  const { records, onDisk, hold } = disk()
  const release = hold()
  records.mark('bot-1', G1)
  records.mark('bot-1', G2)
  records.mark('bot-1', G1)
  records.mark('bot-1', G2)
  release()
  await records.settled()
  expect(onDisk.get('bot-1')).toEqual(G2)
  expect(await records.get('bot-1')).toEqual(G2)
})

it('never brings back a deleted bot folder through a record save already on its way', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-slack-icon-shown-'))
  try {
    let present = true
    const events: string[] = []
    let reached = (): void => {}
    const atDirectory = new Promise<void>((resolve) => (reached = resolve))
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const icons = new BotSlackIcons({
      filesystem: {
        ...localBotHomeFilesystem,
        makeDirectory: async (path) => {
          reached()
          await gate
          await localBotHomeFilesystem.makeDirectory(path)
          events.push('saved')
        },
        removeTree: async (path) => {
          events.push('removed')
          await localBotHomeFilesystem.removeTree(path)
        }
      },
      root: () => root,
      bot: (botId) => {
        if (!present) {
          throw new Error('bot_not_found')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the icon store reads only whether the bot exists here
        return { id: botId } as Bot
      },
      enabled: () => true,
      serialize: (work) => work()
    })
    icons.shownRecords.mark('bot-1', G1)
    await atDirectory
    present = false
    const forget = icons.forget('bot-1')
    // Its files go only once the save on its way has landed.
    expect(events).toEqual([])
    release()
    await forget
    expect(events).toEqual(['saved', 'removed'])
    const folder = join(root, createHash('sha256').update('bot-1').digest('hex').slice(0, 32))
    expect(
      await stat(folder).then(
        () => true,
        () => false
      )
    ).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('saves a record marked in any turn while the writer is finishing', async () => {
  for (let depth = 0; depth < 12; depth += 1) {
    const onDisk = new Map<string, BotSlackIconShown | null>()
    const records: BotSlackIconShownRecords = new BotSlackIconShownRecords({
      read: async () => null,
      write: async (botId, shown) => {
        onDisk.set(botId, shown)
        if (botId === 'bot-1') {
          // Another upload's mark, `depth` turns after this last save lands.
          let later = Promise.resolve()
          for (let turn = 0; turn < depth; turn += 1) {
            later = later.then(() => undefined)
          }
          void later.then(() => records.mark('bot-2', G2))
        }
      },
      exists: () => true
    })
    records.mark('bot-1', G1)
    await idle()
    expect(onDisk.get('bot-2')).toEqual(G2)
  }
})

it('waits for a stuck disk once at quit, however many shutdown paths ask', async () => {
  vi.useFakeTimers()
  try {
    const { records, hold } = disk()
    hold()
    records.mark('bot-1', G1)
    let done = 0
    void records.finalSave().then(() => (done += 1))
    await vi.advanceTimersByTimeAsync(BOT_SLACK_ICON_SHOWN_SETTLE_MS / 2)
    void records.finalSave().then(() => (done += 1))
    await vi.advanceTimersByTimeAsync(BOT_SLACK_ICON_SHOWN_SETTLE_MS / 2)
    expect(done).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})
