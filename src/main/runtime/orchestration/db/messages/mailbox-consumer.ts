import type { OrchestrationDb } from '../orchestration-db'
import { OrchestrationError } from '../../orchestration-error'
import { potentiallyLiveRemoteAttachmentSql } from '../federation/remote-attachment-liveness'

const ACTIVE_DISPATCH_CONSUMER_SQL = `
  SELECT run_id, consumer_generation FROM dispatch_contexts
  WHERE id = ? AND status IN ('pending', 'dispatched')
`
const ACTIVE_ATTACHMENT_CONSUMER_SQL = `
  SELECT home_run_id AS run_id, consumer_generation FROM remote_dispatch_attachments
  WHERE dispatch_id = ? AND ${potentiallyLiveRemoteAttachmentSql()}
`

// Validate inside the delivery transaction, so another connection cannot replace the consumer mid-check.
export function requireMailboxConsumer(
  db: OrchestrationDb,
  params: {
    runId: string
    mailboxHandle: string
    consumerGeneration: number
    consumerSource?: 'dispatch' | 'attachment'
  }
): void {
  if (params.mailboxHandle === `run:${params.runId}`) {
    db.requireCurrentConsumer(params.runId, params.consumerGeneration)
    return
  }
  const dispatchId = params.mailboxHandle.startsWith('dispatch:')
    ? params.mailboxHandle.slice('dispatch:'.length)
    : ''
  // A loopback runtime has both records; use the counter belonging to the caller's attachment.
  const sql =
    params.consumerSource === 'attachment'
      ? ACTIVE_ATTACHMENT_CONSUMER_SQL
      : ACTIVE_DISPATCH_CONSUMER_SQL
  const consumer = db.db.prepare(sql).get(dispatchId) as
    | { run_id: string; consumer_generation: number }
    | undefined
  if (
    consumer?.run_id !== params.runId ||
    consumer.consumer_generation !== params.consumerGeneration
  ) {
    throw new OrchestrationError('consumer_fenced', 'This mailbox consumer has been replaced.')
  }
}
