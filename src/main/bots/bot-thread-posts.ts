import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { mintAgentSessionOperationId } from '../runtime/orchestration/mailbox/structured-pointer/structured-pointer-operation-id'

export type BotThreadPost = {
  botId: string
  deliveryId: string
  correlationId?: string
  text: string
  wake: boolean
}

const Destination = z.enum(['thread', 'inbox'])
const BotThreadReceipt = z.object({
  delivery_id: z.string(),
  message_id: z.string(),
  thread_id: z.string(),
  destination: Destination,
  wake: z.boolean()
})

export type BotThreadReceipt = z.infer<typeof BotThreadReceipt>

const PostRow = z.object({
  thread_id: z.string(),
  destination: Destination,
  text: z.string(),
  wake: z.union([z.literal(0), z.literal(1)]),
  operation_id: z.string(),
  receipt: z.string().nullable()
})

type PostRow = z.infer<typeof PostRow>

type Database = OrchestrationDb['db']

type PostDependencies = {
  database: () => Database
  account: () => string | null
  openThread: (botId: string, threadId: string) => Promise<string | null>
  ensureInbox: (botId: string, threadId: string) => Promise<void>
  write: (botId: string, post: PostRow, checkAccount: () => void) => Promise<string>
}

export class BotThreadPosts {
  private readonly queues = new Map<string, Promise<void>>()
  private initialized: Database | undefined

  constructor(private readonly deps: PostDependencies) {}

  bind(account: string, botId: string, threadId: string, requestId: string): string {
    this.checkAccount(account)
    const db = this.database()
    const correlationId = randomUUID()
    db.prepare(`
      INSERT INTO bot_thread_bindings (correlation_id, account, bot_id, thread_id, request_id)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, bot_id, request_id) DO NOTHING
    `).run(correlationId, account, botId, threadId, requestId)
    const row = db
      .prepare(`
      SELECT correlation_id FROM bot_thread_bindings WHERE account = ? AND bot_id = ? AND request_id = ?
    `)
      .get(account, botId, requestId)
    return z.string().parse(row?.correlation_id)
  }

  postToThread(account: string, input: BotThreadPost): Promise<BotThreadReceipt> {
    const key = JSON.stringify([account, input.botId, input.deliveryId])
    return runKeyedSerializedOperation(this.queues, key, async () => {
      const checkAccount = () => this.checkAccount(account)
      checkAccount()
      const db = this.database()
      const getPost = () =>
        db
          .prepare(`
          SELECT thread_id, destination, text, wake, operation_id, receipt FROM bot_thread_posts
          WHERE account = ? AND bot_id = ? AND delivery_id = ?
        `)
          .get(account, input.botId, input.deliveryId)
      let row = getPost()
      if (!row) {
        const binding = input.correlationId
          ? db
              .prepare(`
              SELECT thread_id FROM bot_thread_bindings
              WHERE correlation_id = ? AND account = ? AND bot_id = ?
            `)
              .get(input.correlationId, account, input.botId)
          : undefined
        const threadId =
          typeof binding?.thread_id === 'string' &&
          (await this.deps.openThread(input.botId, binding.thread_id))
        checkAccount()
        const destination = threadId ? 'thread' : 'inbox'
        const target = threadId || this.inboxId(db, account, input.botId)
        // Freeze routing and message before writing across the journal boundary.
        db.prepare(`
          INSERT INTO bot_thread_posts (account, bot_id, delivery_id, thread_id, destination, text, wake, operation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account, bot_id, delivery_id) DO NOTHING
        `).run(
          account,
          input.botId,
          input.deliveryId,
          target,
          destination,
          input.text,
          Number(destination === 'thread' && input.wake),
          mintAgentSessionOperationId(Date.now())
        )
        row = getPost()
      }
      const post = PostRow.parse(row)
      if (post.receipt) {
        return BotThreadReceipt.parse(JSON.parse(post.receipt))
      }
      if (post.destination === 'inbox') {
        await this.ensureInbox(account, input.botId, post.thread_id)
      }
      checkAccount()
      const messageId = await this.deps.write(input.botId, post, checkAccount)
      const receipt: BotThreadReceipt = {
        delivery_id: input.deliveryId,
        message_id: messageId,
        thread_id: post.thread_id,
        destination: post.destination,
        wake: post.wake === 1
      }
      db.prepare(`
        UPDATE bot_thread_posts SET receipt = ?, text = ''
        WHERE account = ? AND bot_id = ? AND delivery_id = ?
      `).run(JSON.stringify(receipt), account, input.botId, input.deliveryId)
      return receipt
    })
  }

  private ensureInbox(account: string, botId: string, threadId: string): Promise<void> {
    return runKeyedSerializedOperation(this.queues, JSON.stringify([account, botId]), async () => {
      this.checkAccount(account)
      await this.deps.ensureInbox(botId, threadId)
    })
  }

  private inboxId(db: Database, account: string, botId: string): string {
    db.prepare(`
      INSERT INTO bot_thread_inboxes (account, bot_id, thread_id)
      VALUES (?, ?, ?) ON CONFLICT(account, bot_id) DO NOTHING
    `).run(account, botId, randomUUID())
    const row = db
      .prepare(`
      SELECT thread_id FROM bot_thread_inboxes WHERE account = ? AND bot_id = ?
    `)
      .get(account, botId)
    return z.string().parse(row?.thread_id)
  }

  private checkAccount(account: string): void {
    if (!account || this.deps.account() !== account) {
      throw new Error('The Orca account changed during the delivery.')
    }
  }

  private database(): Database {
    const database = this.deps.database()
    if (database !== this.initialized) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS bot_thread_bindings (
          correlation_id TEXT PRIMARY KEY,
          account TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          UNIQUE (account, bot_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS bot_thread_inboxes (
          account TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          PRIMARY KEY (account, bot_id)
        );
        CREATE TABLE IF NOT EXISTS bot_thread_posts (
          account TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          destination TEXT NOT NULL,
          text TEXT NOT NULL,
          wake INTEGER NOT NULL,
          operation_id TEXT NOT NULL,
          receipt TEXT,
          PRIMARY KEY (account, bot_id, delivery_id)
        );
      `)
      this.initialized = database
    }
    return database
  }
}
