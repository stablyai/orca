import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'

/** A fake journal's readOwed over its rows, the way the journal pages them: one account's filled,
 *  unsent rows after a delivery id, in delivery id order. */
export function owedPage(
  rows: readonly JournalConnectorReplyRow[],
  account: string,
  after: string | null,
  limit: number
): JournalConnectorReplyRow[] {
  return rows
    .filter(
      (row) =>
        row.account === account &&
        row.fill !== undefined &&
        (after === null || row.deliveryId > after)
    )
    .sort((a, b) => (a.deliveryId < b.deliveryId ? -1 : a.deliveryId > b.deliveryId ? 1 : 0))
    .slice(0, limit)
}
