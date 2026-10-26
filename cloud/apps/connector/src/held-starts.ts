import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { ConnectorAdapter } from './connector-adapter.js'
import type { ConnectorInbox } from './connector-inbox.js'
import { threadPlace } from './connector-threads.js'

const STARTS_PER_PASS = 10

const HeldPayloadSchema = z.looseObject({ prompt: z.string() })

// Finishes one source's starts for mentions partway through a thread (decisions §6: the request plus
// the thread start, labelled). Routing queues them held; this reads the thread off the request path
// and attaches it, and the inbox lets them go. Their follow-ups wait behind them in the inbox.
export class HeldStarts {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      inbox: ConnectorInbox
      adapter: Pick<ConnectorAdapter, 'source' | 'heldStartPrompt'>
      now: () => number
    }
  ) {}

  async buildDue(): Promise<void> {
    const { database, inbox, adapter } = this.deps
    const rows = await database.query(
      `SELECT i.host_id, i.delivery_id, i.message_id, i.payload, t.workspace_id, t.container_id,
         t.thread_id
       FROM connector_inbox i
       JOIN connector_threads t
         ON t.source = i.source AND t.external_id = i.external_id AND t.host_id = i.host_id
       WHERE i.source = ? AND i.state = 'held' AND i.message_id IS NOT NULL AND i.expires_at > ?
       ORDER BY i.expires_at LIMIT ?`,
      [adapter.source, this.deps.now(), STARTS_PER_PASS]
    )
    for (const row of rows) {
      const prompt = await adapter.heldStartPrompt({
        place: threadPlace(row),
        messageId: String(row.message_id),
        request: HeldPayloadSchema.parse(JSON.parse(String(row.payload))).prompt
      })
      await database.transaction((transaction) =>
        inbox.attach(transaction, String(row.host_id), String(row.delivery_id), prompt)
      )
    }
  }
}
