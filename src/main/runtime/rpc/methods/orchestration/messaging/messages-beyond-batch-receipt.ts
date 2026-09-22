import type { MessageRow } from '../../../../orchestration/db'
import { exposeMessages } from './mailbox-message-receipt'

/**
 * Reports unread mail a replayed batch does not contain.
 *
 * Added only when there is something to report, so every receipt that is not overtaken stays
 * byte-identical for a client that predates the field. These rows are shown, not consumed: the
 * next Delivery after the batch is acknowledged is what hands them over.
 */
export function exposeMessagesBeyondBatch(
  newerMessages: readonly MessageRow[] | undefined
):
  | { newerMessages: ReturnType<typeof exposeMessages>; newerCount: number }
  | Record<string, never> {
  return newerMessages && newerMessages.length > 0
    ? {
        newerMessages: exposeMessages([...newerMessages]),
        newerCount: newerMessages.length
      }
    : {}
}
