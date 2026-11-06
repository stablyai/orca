import { EventEmitter } from 'node:events'
import pg from 'pg'
import type { CloudDatabase } from './cloud-database.js'

const LISTEN_CONNECTION_TIMEOUT_MS = 2_000
const LISTEN_RETRY_BASE_MS = 1_000
const LISTEN_RETRY_MAX_MS = 30_000
// LISTEN takes no bind parameters, so a channel is a plain identifier.
const CHANNEL_NAME = /^[a-z][a-z0-9_]{0,62}$/

export type ListenHandlers = { onNotify: (payload: string) => void; onReconnect: () => void }

export type CloudNotifications = {
  // Postgres: NOTIFY on the caller's connection, so inside a transaction it is sent at commit.
  // SQLite: wakes this process's listeners at once; they re-read, so a rollback costs one query.
  notify(database: CloudDatabase, channel: string, payload: string): Promise<void>
  // Postgres holds one dedicated connection and calls onReconnect after listening again,
  // because notifications sent while it was down are lost.
  listen(channel: string, handlers: ListenHandlers): Promise<() => Promise<void>>
}

function requireChannel(channel: string): string {
  if (!CHANNEL_NAME.test(channel)) {
    throw new Error('invalid_listen_channel')
  }
  return channel
}

// Pass the same databaseUrl as openCloudDatabase; without one, notifications stay in this process.
export function openCloudNotifications(input: {
  databaseUrl?: string
  applicationName?: string
}): CloudNotifications {
  const local = new EventEmitter()
  const { databaseUrl } = input
  return {
    notify: async (database, channel, payload) => {
      requireChannel(channel)
      if (database.dialect === 'postgres') {
        await database.query('SELECT pg_notify(?, ?)', [channel, payload])
      } else {
        local.emit(channel, payload)
      }
    },
    listen: async (channel, handlers) => {
      requireChannel(channel)
      if (!databaseUrl) {
        const onNotify = (payload: string): void => handlers.onNotify(payload)
        local.on(channel, onNotify)
        return async () => {
          local.off(channel, onNotify)
        }
      }
      const listener = new PostgresListener(
        {
          connectionString: databaseUrl,
          application_name: input.applicationName ? `${input.applicationName}/listen` : undefined,
          connectionTimeoutMillis: LISTEN_CONNECTION_TIMEOUT_MS
        },
        channel,
        handlers
      )
      await listener.connect()
      return () => listener.close()
    }
  }
}

// One LISTEN connection outside any pool, reconnected with doubling backoff until closed.
class PostgresListener {
  private client: pg.Client | null = null
  private retry: NodeJS.Timeout | undefined
  private closed = false
  private retryMs = LISTEN_RETRY_BASE_MS

  constructor(
    private readonly connection: pg.ClientConfig,
    private readonly channel: string,
    private readonly handlers: ListenHandlers
  ) {}

  async connect(): Promise<void> {
    const client = new pg.Client(this.connection)
    client.on('notification', (message) => {
      if (message.channel === this.channel) {
        this.handlers.onNotify(message.payload ?? '')
      }
    })
    client.on('error', () => this.drop(client))
    client.on('end', () => this.drop(client))
    try {
      await client.connect()
      await client.query(`LISTEN ${this.channel}`)
    } catch (error) {
      await client.end().catch(() => undefined)
      throw error
    }
    this.client = client
    this.retryMs = LISTEN_RETRY_BASE_MS
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    await this.client?.end().catch(() => undefined)
  }

  private drop(client: pg.Client): void {
    if (this.client !== client) {
      return
    }
    this.client = null
    void client.end().catch(() => undefined)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return
    }
    this.retry = setTimeout(() => {
      this.connect().then(
        () => {
          if (this.closed) {
            void this.client?.end().catch(() => undefined)
          } else {
            this.handlers.onReconnect()
          }
        },
        () => {
          this.retryMs = Math.min(this.retryMs * 2, LISTEN_RETRY_MAX_MS)
          this.scheduleReconnect()
        }
      )
    }, this.retryMs)
    this.retry.unref()
  }
}
