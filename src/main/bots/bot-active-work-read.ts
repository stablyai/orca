// Reads a bot's live work for any of its turns: open items and the work record, cached for a few
// seconds per bot, since the work record checks each worker it lists.
import type { BotItem } from '../../shared/bots/bot-items'
import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { type BotActiveWorkSection, botActiveWorkSection } from './bot-active-work'
import type { BotItemRecord } from './bot-items-schema'
import { type BotItemAccess, botItemListScope } from './bot-item-access'

const FRESH_MS = 15_000
/** Items in progress or waiting read, newest first; the block shows at most 12 rows anyway. */
const WORKING_READ = 12
/** Needs you items are read whole, a page at a time, so the oldest ask is never the one cut. */
const PAGE = 100

type Listed = Pick<BotItemRecord, 'number' | 'lastActivityAt'>
type Shown = Parameters<typeof botActiveWorkSection>[0][number]

export type BotActiveWorkReads<R extends Listed = BotItemRecord> = {
  items: (
    status: 'needs_you' | 'working' | 'waiting',
    limit: number,
    cursor?: { at: number; number: number }
  ) => Promise<{ items: R[]; counts: Partial<Record<BotItem['status'], number>> }>
  views: (items: readonly R[]) => Promise<Shown[]>
  workers: () => Promise<BotWorkerSummary[]>
}

type Cached = { at: number; section: Promise<BotActiveWorkSection> }

/** A reader of the section, which rejects on a failure so the turn keeps what it last had. */
export function createBotActiveWorkReader() {
  const cache = new Map<string, Cached>()
  return async <R extends Listed>(
    /** The bot and the scope its reads cover: one cache entry each. */
    key: string,
    reads: BotActiveWorkReads<R>,
    now = Date.now()
  ): Promise<BotActiveWorkSection> => {
    const hit = cache.get(key)
    if (hit && now - hit.at < FRESH_MS) {
      return hit.section
    }
    const section = (async () => {
      const needsYou: R[] = []
      let page = await reads.items('needs_you', PAGE)
      needsYou.push(...page.items)
      while (page.items.length === PAGE) {
        const last = page.items.at(-1)!
        page = await reads.items('needs_you', PAGE, {
          at: last.lastActivityAt,
          number: last.number
        })
        needsYou.push(...page.items)
      }
      const [working, waiting, workers] = await Promise.all([
        reads.items('working', WORKING_READ),
        reads.items('waiting', WORKING_READ),
        reads.workers()
      ])
      const items = await reads.views([...needsYou, ...working.items, ...waiting.items])
      return botActiveWorkSection(items, workers, {
        // Items the reads left out still count toward "N more".
        unread:
          Math.max(0, (working.counts.working ?? 0) - working.items.length) +
          Math.max(0, (waiting.counts.waiting ?? 0) - waiting.items.length) +
          Math.max(0, (page.counts.needs_you ?? 0) - needsYou.length),
        now
      })
    })()
    cache.set(key, { at: now, section })
    // A failed read is tried again on the next turn, never kept.
    section.catch(() => cache.get(key)?.section === section && cache.delete(key))
    return section
  }
}

const readers = new WeakMap<OrcaRuntimeService, ReturnType<typeof createBotActiveWorkReader>>()

/** What a turn's live work holds: whose items, and whether the bot's workers too. */
export type BotActiveWorkScope = { items: BotItemAccess; workers: boolean }

function scopeKey({ items, workers }: BotActiveWorkScope): string {
  return JSON.stringify([items.kind === 'everyone' ? '*' : items.accounts, workers])
}

/** The runtime's reads for a turn of one of `botId`'s chats. */
export function readBotActiveWork(
  runtime: OrcaRuntimeService,
  botId: string,
  scope: BotActiveWorkScope
): Promise<BotActiveWorkSection> {
  const reader = readers.get(runtime) ?? createBotActiveWorkReader()
  readers.set(runtime, reader)
  const people = botItemListScope(scope.items)
  return reader(`${botId}\n${scopeKey(scope)}`, {
    items: (status, limit, cursor) =>
      runtime.botItems
        .store()
        .list({ botId, statuses: [status], ...people, limit, ...(cursor ? { cursor } : {}) }),
    views: (items) => runtime.botItems.views(items),
    workers: async () => (scope.workers ? runtime.botWork.list(botId) : [])
  })
}
