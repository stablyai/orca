// Which Dispatches any item links, held on the main side so a Dispatch row change no item links costs
// no bots DB worker call. Every write through the store drops it; the next read reloads it from the file.
import type { BotItemsCallWrap, BotItemsOp, BotItemsRemote } from './bot-items-ops'

const READ_OPS: ReadonlySet<BotItemsOp> = new Set<BotItemsOp>([
  'get',
  'byNumber',
  'links',
  'events',
  'eventsBefore',
  'linksTo',
  'reportFact',
  'linkedDispatchRefs',
  'usageLimitWaitUids',
  'list',
  'needsYou',
  'viewRows',
  'closes',
  'latestEventId',
  'owedMail'
])

export type TrackedBotItems = {
  remote: BotItemsRemote
  /** Every Dispatch ref an item links, as of the last write this store made. */
  linkedDispatches: () => Promise<ReadonlySet<string>>
}

/** The store `open` makes, its writes counted on the way through. */
export function trackDispatchLinks(
  open: (around: BotItemsCallWrap) => BotItemsRemote
): TrackedBotItems {
  // Bumped as each write starts and settles; a load overlapping one is not kept.
  let generation = 0
  let writing = 0
  let cached: { generation: number; refs: ReadonlySet<string> } | null = null
  const remote = open(async (op, run) => {
    if (READ_OPS.has(op)) {
      return run()
    }
    generation++
    writing++
    try {
      return await run()
    } finally {
      writing--
      generation++
    }
  })
  return {
    remote,
    linkedDispatches: async () => {
      if (cached?.generation === generation) {
        return cached.refs
      }
      const at = generation
      const refs = new Set(await remote.linkedDispatchRefs())
      if (writing === 0 && generation === at) {
        cached = { generation, refs }
      }
      return refs
    }
  }
}
