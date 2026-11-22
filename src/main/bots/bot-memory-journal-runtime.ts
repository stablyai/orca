// When a bot's items change, journals the ones that closed since its last pass, one pass per bot
// at a time and on its memory queue, so journal writes never interleave with a tidy-up's.
import type { Bot } from '../../shared/bot-types'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import { type BotHomeFilesystem, botHomeFolder, localBotHomeFilesystem } from './bot-home'
import type { BotItemsHost } from './bot-items-runtime'
import type { BotItemRecord } from './bot-items-schema'
import type { BotMemoryRecord } from './bot-memory-record'
import { appendJournalLines, type JournalItem, journalLines } from './bot-memory-journal'

/** How far back a pass looks the first time after a start, so closes while Orca was down count. */
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000
/** Closed items read per page, by latest activity; a pass reads pages until the window is covered. */
const CLOSED_READ = 100

export function createBotMemoryJournal(deps: {
  bots: () => readonly Bot[]
  /** The bot's items closed at or after `since`, every one of them. */
  closedItems: (botId: string, since: number) => Promise<JournalItem[]>
  folder: (bot: Bot) => string
  /** Runs `step` on the bot's memory queue. */
  serialize: (botId: string, step: () => Promise<void>) => Promise<void>
  fs: Pick<BotHomeFilesystem, 'readText' | 'writeText' | 'replaceText' | 'makeDirectory'>
  now: () => number
}): { itemsChanged: (botIds: readonly string[]) => void; settled: () => Promise<void> } {
  const since = new Map<string, number>()
  const running = new Map<string, Promise<void>>()
  const again = new Set<string>()

  const pass = async (bot: Bot): Promise<void> => {
    const from = since.get(bot.id) ?? deps.now() - FIRST_LOOKBACK_MS
    const closed = (await deps.closedItems(bot.id, from)).filter((item) => item.closedAt >= from)
    const lines = closed.toSorted((a, b) => a.closedAt - b.closedAt).flatMap(journalLines)
    if (lines.length > 0) {
      await deps.serialize(bot.id, async () => {
        await appendJournalLines(deps.fs, deps.folder(bot), lines)
      })
    }
    // Only after the lines are written: a failed write leaves them for the next pass.
    since.set(bot.id, Math.max(from, ...closed.map((item) => item.closedAt)))
  }

  const run = (bot: Bot): void => {
    if (running.has(bot.id)) {
      again.add(bot.id)
      return
    }
    const done = pass(bot)
      .catch((error: unknown) => console.warn('[bots] could not write the journal', error))
      .finally(() => {
        running.delete(bot.id)
        if (again.delete(bot.id)) {
          run(bot)
        }
      })
    running.set(bot.id, done)
  }

  return {
    itemsChanged: (botIds) => {
      const wanted = new Set(botIds)
      for (const bot of deps.bots()) {
        if (wanted.has(bot.id)) {
          run(bot)
        }
      }
    },
    settled: async () => {
      while (running.size > 0) {
        await Promise.all(running.values())
      }
    }
  }
}

/** Every item of the bot closed at or after `since`, with its view. Pages by latest activity: a
 *  close is its item's activity too, so once a page reaches activity before `since`, no later page
 *  holds a close after it. */
export async function readClosedSince<
  R extends Pick<BotItemRecord, 'number' | 'lastActivityAt' | 'closedAt'>
>(
  list: (query: {
    statuses: BotItemRecord['status'][]
    limit: number
    cursor?: { at: number; number: number }
  }) => Promise<{ items: R[] }>,
  views: (records: R[]) => Promise<(Omit<JournalItem, 'closedAt'> | undefined)[]>,
  since: number
): Promise<JournalItem[]> {
  const records: R[] = []
  let cursor: { at: number; number: number } | undefined
  for (;;) {
    const { items: page } = await list({
      statuses: ['done', 'canceled'],
      limit: CLOSED_READ,
      ...(cursor ? { cursor } : {})
    })
    records.push(...page.filter(({ closedAt }) => closedAt !== null && closedAt >= since))
    const last = page.at(-1)
    if (!last || page.length < CLOSED_READ || last.lastActivityAt < since) {
      break
    }
    cursor = { at: last.lastActivityAt, number: last.number }
  }
  const shown = await views(records)
  return records.flatMap((record, index) => {
    const view = shown[index]
    return view && record.closedAt !== null ? [{ ...view, closedAt: record.closedAt }] : []
  })
}

/** The host's Items notice, which also journals each bot's closed items on its memory queue. */
export function journaledItemsNotice(
  runtime: {
    bots: { list: () => readonly Bot[]; memory: Pick<BotMemoryRecord, 'after'> }
    botItems: Pick<BotItemsHost, 'store' | 'views'>
  },
  notify: (scope: BotChangeScope) => void
): ((scope: BotChangeScope) => void) & { catchUp: () => void } {
  const journal = createBotMemoryJournal({
    bots: () => runtime.bots.list(),
    closedItems: (botId, since) =>
      readClosedSince(
        (query) => runtime.botItems.store().list({ botId, ...query }),
        (records) => runtime.botItems.views(records),
        since
      ),
    folder: (bot) => botHomeFolder(bot),
    serialize: (botId, step) =>
      runtime.bots.memory.after(botId, async () => {
        await step()
        return undefined
      }),
    fs: localBotHomeFilesystem,
    now: Date.now
  })
  const notice = (scope: BotChangeScope): void => {
    notify(scope)
    if (scope.kinds?.includes('items')) {
      journal.itemsChanged(scope.botIds ?? [])
    }
  }
  // After a restart no notice comes for closes made while Orca was off: one pass catches up.
  return Object.assign(notice, {
    catchUp: () => journal.itemsChanged(runtime.bots.list().map(({ id }) => id))
  })
}
