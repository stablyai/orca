// The open item a finished worker's report was started for, read from the item store when the report
// is shown. Guidance only: any failure or a slow read shows the report without it.
import { isOpenBotItemStatus } from '../../shared/bots/bot-items'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { StructuredMailReportItem } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { currentCompletionReportDispatchId } from '../runtime/orchestration/workers/reports/report-follow-up-action'
import { dispatchItemUid, lineageAncestors } from './bot-item-dispatch-facts'
import type { BotItemsRemote } from './bot-items-ops'

const REPORT_ITEM_READ_TIMEOUT_MS = 2_000

/** Reads, from `items`' store, the open item a finished worker's report was started for, or that links
 *  any step of its worker (`bot item link`, `send --to dispatch: --item`), with the places it links. */
export function botItemOfReport(items: { store(): BotItemsRemote }): StructuredMailReportItem {
  return async (db, message) => {
    const dispatchId = currentCompletionReportDispatchId(db, message)
    if (!dispatchId) {
      return null
    }
    const chain = lineageAncestors(db, dispatchId)
    const started = chain.map((id) => dispatchItemUid(db, id)).find((uid) => uid !== null)
    return withTimeout(
      (async () => {
        const store = items.store()
        const uid = started ?? (await linkingItemUid(store, chain))
        const item = uid ? await store.get(uid) : null
        if (!item || !isOpenBotItemStatus(item.status)) {
          return null
        }
        const places = (await store.links(item.uid))
          .filter((link) => link.kind === 'url')
          .map((link) => link.ref)
        return {
          number: item.number,
          title: item.title,
          status: item.status,
          doneMeans: item.doneMeans,
          ...(places.length > 0 ? { places } : {})
        }
      })(),
      REPORT_ITEM_READ_TIMEOUT_MS,
      null
    )
  }
}

/** The one item that links a step of this worker; none when several do. */
async function linkingItemUid(store: BotItemsRemote, chain: string[]): Promise<string | null> {
  const uids = new Set((await store.linksTo('dispatch', chain)).map((link) => link.itemUid))
  return uids.size === 1 ? ([...uids][0] ?? null) : null
}
