// The open item a finished worker's report was started for, read from the item store when the report
// is shown. Guidance only: any failure or a slow read shows the report without it.
import { isOpenBotItemStatus } from '../../shared/bots/bot-items'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { StructuredMailReportItem } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { currentCompletionReportDispatchId } from '../runtime/orchestration/workers/reports/report-follow-up-action'
import { dispatchItemUid } from './bot-item-dispatch-facts'
import type { BotItemsRemote } from './bot-items-ops'

const REPORT_ITEM_READ_TIMEOUT_MS = 2_000

/** Reads, from `items`' store, the open item a finished worker's report was started for. */
export function botItemOfReport(items: { store(): BotItemsRemote }): StructuredMailReportItem {
  return async (db, message) => {
    const dispatchId = currentCompletionReportDispatchId(db, message)
    const uid = dispatchId ? dispatchItemUid(db, dispatchId) : null
    if (!uid) {
      return null
    }
    const item = await withTimeout(
      (async () => items.store().get(uid))(),
      REPORT_ITEM_READ_TIMEOUT_MS,
      null
    )
    return item && isOpenBotItemStatus(item.status)
      ? { number: item.number, title: item.title, status: item.status, doneMeans: item.doneMeans }
      : null
  }
}
