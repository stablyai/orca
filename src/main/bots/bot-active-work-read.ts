// Reads a bot's live work for a turn its owner asked: open items and the work record, cached for a
// few seconds per bot, since the work record checks each worker it lists.
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { actsForOwner, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotItem } from '../../shared/bots/bot-items'
import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readBotTurn } from '../runtime/rpc/methods/orchestration/messaging/bot-recipient'
import { type BotActiveWorkSection, botActiveWorkSection } from './bot-active-work'
import type { BotItemRecord } from './bot-items-schema'

const FRESH_MS = 15_000
/** Items in progress read, newest first; the block shows at most 12 rows anyway. */
const WORKING_READ = 12
/** Waiting items are read whole, a page at a time, so the oldest wait is never the one cut. */
const PAGE = 100

type Listed = Pick<BotItemRecord, 'number' | 'lastActivityAt'>
type Shown = Parameters<typeof botActiveWorkSection>[0][number]

export type BotActiveWorkReads<R extends Listed = BotItemRecord> = {
  /** Whom this turn acts for. */
  askers: () => Promise<readonly BotRequestAsker[]>
  items: (
    status: 'needs_you' | 'working',
    limit: number,
    cursor?: { at: number; number: number }
  ) => Promise<{ items: R[]; counts: Partial<Record<BotItem['status'], number>> }>
  views: (items: readonly R[]) => Promise<Shown[]>
  workers: () => Promise<BotWorkerSummary[]>
}

type Cached = { at: number; section: Promise<BotActiveWorkSection> }

/** A reader that settles who the turn acts for first: null when it isn't only the owner (nothing is
 *  read or cached), else the section's read, which rejects on a failure so the turn keeps what it
 *  last had. */
export function createBotActiveWorkReader() {
  const cache = new Map<string, Cached>()
  return async <R extends Listed>(
    botId: string,
    reads: BotActiveWorkReads<R>,
    now = Date.now()
  ): Promise<{ section: Promise<BotActiveWorkSection> } | null> => {
    if (!actsForOwner(await reads.askers())) {
      return null
    }
    const hit = cache.get(botId)
    if (hit && now - hit.at < FRESH_MS) {
      return { section: hit.section }
    }
    const section = (async () => {
      const waiting: R[] = []
      let page = await reads.items('needs_you', PAGE)
      waiting.push(...page.items)
      while (page.items.length === PAGE) {
        const last = page.items.at(-1)!
        page = await reads.items('needs_you', PAGE, {
          at: last.lastActivityAt,
          number: last.number
        })
        waiting.push(...page.items)
      }
      const [working, workers] = await Promise.all([
        reads.items('working', WORKING_READ),
        reads.workers()
      ])
      const items = await reads.views([...waiting, ...working.items])
      return botActiveWorkSection(items, workers, {
        // Items the reads left out still count toward "N more".
        unread:
          Math.max(0, (working.counts.working ?? 0) - working.items.length) +
          Math.max(0, (page.counts.needs_you ?? 0) - waiting.length),
        now
      })
    })()
    cache.set(botId, { at: now, section })
    // A failed read is tried again on the next turn, never kept.
    section.catch(() => cache.get(botId)?.section === section && cache.delete(botId))
    return { section }
  }
}

const readers = new WeakMap<OrcaRuntimeService, ReturnType<typeof createBotActiveWorkReader>>()

/** The runtime's reads for a turn of `sessionId`, a chat of `botId`. */
export function readBotActiveWork(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string,
  message: AgentJournalMessageItem
): Promise<{ section: Promise<BotActiveWorkSection> } | null> {
  const reader = readers.get(runtime) ?? createBotActiveWorkReader()
  readers.set(runtime, reader)
  return reader(botId, {
    askers: async () =>
      (await readBotTurn(runtime, runtime.getOrchestrationDb(), sessionId, message)).turn.askers,
    items: (status, limit, cursor) =>
      runtime.botItems
        .store()
        .list({ botId, statuses: [status], limit, ...(cursor ? { cursor } : {}) }),
    views: (items) => runtime.botItems.views(items),
    workers: () => runtime.botWork.list(botId)
  })
}
