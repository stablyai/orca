import type { CloudDatabase, CloudNotifications } from '@orca-cloud/cloud-database'
import type { ConnectorConfig } from './config.js'
import { createConnectorCore } from './connector-core.js'
import { ConnectorHosts } from './connector-hosts.js'
import { ConnectorInbox } from './connector-inbox.js'
import { ConnectorThreads } from './connector-threads.js'
import { createDiscordEdge } from './discord-edge.js'
import type { DiscordRestApi } from './discord-rest.js'
import { queueDelivery, type QueueInTransaction } from './queue-delivery.js'
import { createSlackEdge } from './slack-edge.js'

// The inbox, the shared core and each configured source's edge, as both roles (the API and the
// Discord gateway worker) build them.
export function createConnectorRuntime(
  config: ConnectorConfig,
  database: CloudDatabase,
  notifications: CloudNotifications,
  options: { now: () => number; discordApi?: DiscordRestApi }
) {
  const { now } = options
  const inbox = new ConnectorInbox(database, notifications, now)
  const hosts = new ConnectorHosts(database, inbox, now)
  const threads = new ConnectorThreads(now)
  const queue = (input: Parameters<typeof queueDelivery>[1]) =>
    queueDelivery({ database, inbox, threads, hosts }, input)
  const queueInTransaction: QueueInTransaction = (transaction, input) =>
    queueDelivery({ database: transaction, inbox, threads, hosts }, input)
  const slack = config.slack ? createSlackEdge({ config: config.slack, database, now }) : undefined
  const discord = config.discord
    ? createDiscordEdge({
        config: config.discord,
        database,
        now,
        ...(options.discordApi ? { api: options.discordApi } : {})
      })
    : undefined
  const core = createConnectorCore({
    database,
    inbox,
    queue: queueInTransaction,
    now,
    adapters: [slack?.adapter, discord?.adapter].flatMap((adapter) => adapter ?? [])
  })
  return { inbox, hosts, threads, queue, core, slack, discord }
}
