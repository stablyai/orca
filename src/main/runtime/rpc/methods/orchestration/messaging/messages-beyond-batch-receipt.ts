import type { MessageRow } from '../../../../orchestration/db'
import { exposeMessages } from './mailbox-message-receipt'

/**
 * Reports unread mail a replayed batch does not contain.
 *
 * Added only when there is something to report, so every receipt that is not overtaken stays
 * byte-identical for a client that predates the field. These rows are shown, not consumed: the
 * next Delivery after the batch is acknowledged is what hands them over.
 *
 * `newerCount` counts what is reported, not what is waiting: the read is bounded by the delivery
 * batch limit, so `newerTruncated` is what says there is more behind it.
 */
export function exposeMessagesBeyondBatch(
  beyondBatch:
    | { newerMessages: readonly MessageRow[]; newerTruncated: boolean }
    | undefined
):
  | {
      newerMessages: ReturnType<typeof exposeMessages>
      newerCount: number
      newerTruncated: boolean
    }
  | Record<string, never> {
  return beyondBatch && beyondBatch.newerMessages.length > 0
    ? {
        newerMessages: exposeMessages([...beyondBatch.newerMessages]),
        newerCount: beyondBatch.newerMessages.length,
        newerTruncated: beyondBatch.newerTruncated
      }
    : {}
}
