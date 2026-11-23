// The open item a finished worker's report was started for, read from the item store when the report
// is shown. Guidance only: any failure or a slow read shows the report without it.
import { isOpenBotItemStatus } from '../../shared/bots/bot-items'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { StructuredMailReportItem } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { currentCompletionReportDispatchId } from '../runtime/orchestration/workers/reports/report-follow-up-action'
import { dispatchItemUid } from './bot-item-dispatch-facts'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemEventRecord } from './bot-items-schema'

const REPORT_ITEM_READ_TIMEOUT_MS = 2_000

/** Reads, from `items`' store, the open item a finished worker's report was started for, and where
 *  that item's work started. */
export function botItemOfReport(items: { store(): BotItemsRemote }): StructuredMailReportItem {
  return async (db, message) => {
    const dispatchId = currentCompletionReportDispatchId(db, message)
    const uid = dispatchId ? dispatchItemUid(db, dispatchId) : null
    if (!uid) {
      return null
    }
    const deadline = Date.now() + REPORT_ITEM_READ_TIMEOUT_MS
    return withTimeout(
      (async () => {
        const store = items.store()
        const item = await store.get(uid)
        // Past the deadline the report has gone out without it: no second read.
        if (!item || !isOpenBotItemStatus(item.status) || Date.now() > deadline) {
          return null
        }
        const startedIn = startedInOf(await store.events(item.uid, 0, 1))
        return {
          number: item.number,
          title: item.title,
          status: item.status,
          doneMeans: item.doneMeans,
          ...(startedIn ? { startedIn } : {})
        }
      })(),
      REPORT_ITEM_READ_TIMEOUT_MS,
      null
    )
  }
}

/** Where the item's work started, as `bot item add` kept it on the item's `made` event. */
function startedInOf(first: readonly BotItemEventRecord[]): string | null {
  const startedIn = first.find((event) => event.kind === 'made')?.data.startedIn
  return typeof startedIn === 'string' && startedIn ? startedIn : null
}
