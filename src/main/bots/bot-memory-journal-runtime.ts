// When a bot's items change, journals the ones that closed since its last pass, one pass per bot
// at a time and on its memory queue, so journal writes never interleave with a tidy-up's.
import type { Bot } from '../../shared/bot-types'
import { isAgentSessionRefusalError } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotChangeScope } from '../../shared/bots/bot-change-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readFirstMessageActsFor } from '../runtime/rpc/methods/orchestration/messaging/bot-first-message-acts-for'
import { type BotHomeFilesystem, botHomeFolder, localBotHomeFilesystem } from './bot-home'
import type { BotItemsHost } from './bot-items-runtime'
import type { BotItemRecord } from './bot-items-schema'
import type { BotMemoryRecord } from './bot-memory-record'
import {
  appendJournalLines,
  journalCloserLabel,
  type JournalItem,
  journalLines
} from './bot-memory-journal'

/** How far back a pass looks the first time after a start, so closes while Orca was down count. */
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000
/** Closed items read per page, by latest activity; a pass reads pages until the window is covered. */
const CLOSED_READ = 100

export type JournalCandidate = JournalItem & { chatId: string }

export function createBotMemoryJournal(deps: {
  bots: () => readonly Bot[]
  /** The bot's items closed at or after `since`, every one of them. */
  closedItems: (botId: string, since: number) => Promise<JournalCandidate[]>
  /** Whom the chat an item closed in acted for; null when Orca can't tell. Rejects on a failed read. */
  chatAskers: (chatId: string) => Promise<readonly BotRequestAsker[] | null>
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
    let from = since.get(bot.id)
    if (from === undefined) {
      // Kept, so a startup pass that has to retry still covers its whole lookback.
      from = deps.now() - FIRST_LOOKBACK_MS
      since.set(bot.id, from)
    }
    const closed = (await deps.closedItems(bot.id, from)).filter((item) => item.closedAt >= from)
    // Each chat once a pass, in turn. A failed read fails the pass before anything is written.
    const labels = new Map<string, string | null>()
    for (const { chatId } of closed) {
      if (!labels.has(chatId)) {
        labels.set(chatId, journalCloserLabel(await deps.chatAskers(chatId)))
      }
    }
    const lines = closed
      .map(({ chatId, ...item }) => ({ ...item, closedFor: labels.get(chatId) ?? undefined }))
      .toSorted((a, b) => a.closedAt - b.closedAt)
      .flatMap(journalLines)
    if (lines.length > 0) {
      await deps.serialize(bot.id, async () => {
        await appendJournalLines(deps.fs, deps.folder(bot), lines)
      })
    }
    // Only after the lines are written: a failed read or write leaves them for the next pass.
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
  R extends Pick<BotItemRecord, 'number' | 'lastActivityAt' | 'closedAt' | 'chatId'>
>(
  list: (query: {
    statuses: BotItemRecord['status'][]
    limit: number
    cursor?: { at: number; number: number }
  }) => Promise<{ items: R[] }>,
  views: (records: R[]) => Promise<(Omit<JournalItem, 'closedAt'> | undefined)[]>,
  since: number
): Promise<JournalCandidate[]> {
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
    return view && record.closedAt !== null
      ? [{ ...view, closedAt: record.closedAt, chatId: record.chatId }]
      : []
  })
}

/**
 * Whom an item's chat acted for, read by its /clear root as every acts-for check keys it: its
 * record, else its first message, as its turns read it (a teammate's connector chat is theirs).
 * Null for a chat with no message, or one Orca no longer has. Any other failed read rejects, so the
 * pass fails and its watermark stays, and the next pass reads the chat again rather than guess.
 */
export function chatAskersOf(deps: {
  root: (chatId: string) => string
  actsFor: (root: string) => readonly BotRequestAsker[] | undefined
  firstMessage: (root: string) => Promise<readonly BotRequestAsker[] | null>
}): (chatId: string) => Promise<readonly BotRequestAsker[] | null> {
  return async (chatId) => {
    const root = deps.root(chatId)
    const recorded = deps.actsFor(root)
    if (recorded) {
      return recorded
    }
    return deps.firstMessage(root).catch((error: unknown) => {
      if (isChatGone(error)) {
        return null
      }
      throw error
    })
  }
}

/** The refusal a read of a chat Orca has no record of throws (deleted, say). */
function isChatGone(error: unknown): boolean {
  return (
    isAgentSessionRefusalError(error) &&
    error.refusal.code === 'agent_session_identity_required' &&
    error.refusal.details?.reason === 'recordMissing'
  )
}

/** The host's Items notice, which also journals each bot's closed items on its memory queue. */
export function journaledItemsNotice(
  runtime: {
    bots: { list: () => readonly Bot[]; memory: Pick<BotMemoryRecord, 'after'> }
    botItems: Pick<BotItemsHost, 'store' | 'views' | 'chatRootOf'>
    getOrchestrationDb: () => OrchestrationDb
  } & Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
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
    chatAskers: chatAskersOf({
      root: (chatId) => runtime.botItems.chatRootOf(chatId),
      actsFor: (root) => runtime.getOrchestrationDb().getBotConversationActsFor(root)?.actsFor,
      // Without its conversation's workspace: whether a person is the owner doesn't depend on it.
      firstMessage: (root) =>
        readFirstMessageActsFor(runtime, runtime.getOrchestrationDb(), root, null)
    }),
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
