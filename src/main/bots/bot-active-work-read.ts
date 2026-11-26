// Reads a bot's live work for any of its turns: open items and the work record, cached for a few
// seconds per bot, since the work record checks each worker it lists.
import { isBotItemSnoozed, type BotItem } from '../../shared/bots/bot-items'
import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  BOT_ACTIVE_WORK,
  botActiveWorkSection,
  nothingRuns,
  type BotActiveWorkSection,
  type BotIdleItem
} from './bot-active-work'
import type { BotItemLinkJoin } from './bot-items-link-join'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemRecord } from './bot-items-schema'
import { BOT_WORK_NOTE_TIMEOUT_MS } from './bot-work-record'

const FRESH_MS = 15_000
/** Items in progress or waiting read, newest first; the block shows at most 12 rows anyway. */
const WORKING_READ = BOT_ACTIVE_WORK.rows
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

export function readBotIdleItems(
  botId: string,
  store: () => Pick<BotItemsRemote, 'workingItems'>,
  join: Pick<BotItemLinkJoin, 'readLinkedWorkers' | 'linkView'>,
  owningChat: (item: Pick<BotItemRecord, 'chatId' | 'source'>) => BotItem['chat'],
  now = Date.now()
): Promise<BotIdleItem[]> {
  const deadline = performance.now() + BOT_WORK_NOTE_TIMEOUT_MS
  const read = async (): Promise<BotIdleItem[]> => {
    const items = await store().workingItems(botId, WORKING_READ)
    if (performance.now() >= deadline) {
      return []
    }
    const candidates = items.filter((item) => !isBotItemSnoozed(item, now))
    const refs = candidates.flatMap(({ links }) =>
      links.flatMap((link) => (link.kind === 'dispatch' ? [link.ref] : []))
    )
    const workers = await join.readLinkedWorkers(refs, { pullRequests: false })
    if (performance.now() >= deadline) {
      return []
    }
    return candidates.flatMap((item) => {
      const links = item.links.map((link) => join.linkView(link, workers.get(link.ref)))
      return nothingRuns({ status: item.status, links })
        ? [{ number: item.number, title: item.title, chat: owningChat(item) }]
        : []
    })
  }
  return withTimeout(read(), BOT_WORK_NOTE_TIMEOUT_MS, [])
}

/** A reader of the section, which rejects on a failure so the turn keeps what it last had. */
export function createBotActiveWorkReader() {
  const cache = new Map<string, Cached>()
  return async <R extends Listed>(
    botId: string,
    reads: BotActiveWorkReads<R>,
    now = Date.now()
  ): Promise<BotActiveWorkSection> => {
    const hit = cache.get(botId)
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
    cache.set(botId, { at: now, section })
    // A failed read is tried again on the next turn, never kept.
    section.catch(() => cache.get(botId)?.section === section && cache.delete(botId))
    return section
  }
}

const readers = new WeakMap<OrcaRuntimeService, ReturnType<typeof createBotActiveWorkReader>>()

/** The runtime's reads for a turn of one of `botId`'s chats. */
export function readBotActiveWork(
  runtime: OrcaRuntimeService,
  botId: string
): Promise<BotActiveWorkSection> {
  const reader = readers.get(runtime) ?? createBotActiveWorkReader()
  readers.set(runtime, reader)
  return reader(botId, {
    items: (status, limit, cursor) =>
      runtime.botItems
        .store()
        .list({ botId, statuses: [status], limit, ...(cursor ? { cursor } : {}) }),
    views: (items) => runtime.botItems.views(items),
    workers: () => runtime.botWork.list(botId)
  })
}
