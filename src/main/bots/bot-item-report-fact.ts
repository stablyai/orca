// The open item a finished worker's report is for, read from the item store when the report is shown.
// Guidance only: any failure or a slow read shows the report without it.
import { isOpenBotItemStatus } from '../../shared/bots/bot-items'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { StructuredMailReportItem } from '../runtime/orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { currentCompletionReportDispatchId } from '../runtime/orchestration/workers/reports/report-follow-up-action'
import { dispatchItemUid, lineageAncestors } from './bot-item-dispatch-facts'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemEventRecord } from './bot-items-schema'

const REPORT_ITEM_READ_TIMEOUT_MS = 2_000
/** Items linking a report's worker read at most, newest link first. */
const MAX_REPORT_ITEM_READS = 8

type ReportItems = {
  store(): BotItemsRemote
  openedStore(): BotItemsRemote | null
  workerStarterBotId(dispatchId: string): string | null
}

/** The open item a finished worker's report is for: the one that linked a step of its worker most
 *  recently (`bot item link`, `send --to dispatch: --item`), else the one it was started for (each
 *  follow-up inherits it), with the place that item's work started in. */
export function botItemOfReport(items: ReportItems): StructuredMailReportItem {
  return async (db, message) => {
    const dispatchId = currentCompletionReportDispatchId(db, message)
    if (!dispatchId) {
      return null
    }
    const started = dispatchItemUid(db, dispatchId)
    // A worker started for no item opens no store: a profile with no items file links none.
    const store = started ? items.store() : items.openedStore()
    if (!store) {
      return null
    }
    const chain = lineageAncestors(db, dispatchId)
    // Only the starting bot's own items: another bot linking this worker never redirects its report.
    const owner = items.workerStarterBotId(dispatchId)
    const deadline = Date.now() + REPORT_ITEM_READ_TIMEOUT_MS
    return withTimeout(
      reportItem(store, chain, started, owner, () => Date.now() > deadline),
      REPORT_ITEM_READ_TIMEOUT_MS,
      null
    )
  }
}

/** Reads stop once the report has gone out without them. */
async function reportItem(
  store: BotItemsRemote,
  chain: string[],
  started: string | null,
  owner: string | null,
  late: () => boolean
) {
  const linked = await store.newestLinkingItems('dispatch', chain, MAX_REPORT_ITEM_READS)
  // The item it was started for is the starter's own; a linked one must be too.
  const mayReport = (itemOwner: string, uid: string) => uid === started || itemOwner === owner
  for (const uid of new Set([...linked, ...(started ? [started] : [])])) {
    if (late()) {
      return null
    }
    const item = await store.get(uid)
    if (item && isOpenBotItemStatus(item.status) && mayReport(item.ownerBotId, uid) && !late()) {
      const startedIn = startedInOf(await store.events(item.uid, 0, 1))
      return {
        number: item.number,
        title: item.title,
        status: item.status,
        doneMeans: item.doneMeans,
        ...(startedIn ? { startedIn } : {})
      }
    }
  }
  return null
}

/** Where the item's work started, as `bot item add` kept it on the item's `made` event. */
function startedInOf(first: readonly BotItemEventRecord[]): string | null {
  const startedIn = first.find((event) => event.kind === 'made')?.data.startedIn
  return typeof startedIn === 'string' && startedIn ? startedIn : null
}
