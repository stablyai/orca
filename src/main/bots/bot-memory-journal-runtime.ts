// When a bot's items change, journals the ones that closed since its last pass, one pass per bot
// at a time and on its memory queue, so journal writes never interleave with a tidy-up's.
import type { Bot } from '../../shared/bot-types'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { type BotHomeFilesystem, botHomeFolder, localBotHomeFilesystem } from './bot-home'
import type { BotItemsHost } from './bot-items-runtime'
import type { BotMemoryRecord } from './bot-memory-record'
import { appendJournalLines, type JournalItem, journalLines } from './bot-memory-journal'

/** How far back a pass looks the first time after a start, so closes while Orca was down count. */
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000
/** Closed items read per pass, by latest activity: each close notices on its own, so a pass rarely has
 *  more than a few new ones. */
const CLOSED_READ = 100

export type JournalCandidate = JournalItem & { chatId: string }

export function createBotMemoryJournal(deps: {
  bots: () => readonly Bot[]
  /** The bot's closed items with the latest activity first. */
  closedItems: (botId: string) => Promise<JournalCandidate[]>
  /** Whether the chat an item came from acts for the bot's owner (unrecorded counts as the owner's). */
  ownerChat: (chatId: string) => boolean
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
    const closed = (await deps.closedItems(bot.id)).filter((item) => item.closedAt >= from)
    const lines = closed
      .filter((item) => deps.ownerChat(item.chatId))
      .toSorted((a, b) => a.closedAt - b.closedAt)
      .flatMap(journalLines)
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

/** The host's Items notice, which also journals each bot's closed items on its memory queue. */
export function journaledItemsNotice(
  runtime: {
    bots: { list: () => readonly Bot[]; memory: Pick<BotMemoryRecord, 'after'> }
    botItems: Pick<BotItemsHost, 'store' | 'views' | 'chatRootOf'>
    getOrchestrationDb: () => OrchestrationDb
  },
  notify: (scope: BotChangeScope) => void
): (scope: BotChangeScope) => void {
  const journal = createBotMemoryJournal({
    bots: () => runtime.bots.list(),
    closedItems: async (botId) => {
      const items = runtime.botItems
      const page = await items
        .store()
        .list({ botId, statuses: ['done', 'canceled'], limit: CLOSED_READ })
      const views = await items.views(page.items)
      return page.items.flatMap((record, index) => {
        const view = views[index]
        return view && record.closedAt !== null
          ? [{ ...view, closedAt: record.closedAt, chatId: record.chatId }]
          : []
      })
    },
    // Keyed by the conversation's /clear root, as every acts-for check reads it.
    ownerChat: (chatId) => {
      const root = runtime.botItems.chatRootOf(chatId)
      const recorded = runtime.getOrchestrationDb().getBotConversationActsFor(root)
      return !recorded || actsForOwner(recorded.actsFor)
    },
    folder: (bot) => botHomeFolder(bot),
    serialize: (botId, step) =>
      runtime.bots.memory.after(botId, async () => {
        await step()
        return undefined
      }),
    fs: localBotHomeFilesystem,
    now: Date.now
  })
  return (scope) => {
    notify(scope)
    if (scope.kinds?.includes('items')) {
      journal.itemsChanged(scope.botIds ?? [])
    }
  }
}
