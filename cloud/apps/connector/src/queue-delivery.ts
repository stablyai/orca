import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { lockConnectorHost, type ConnectorHosts } from './connector-hosts.js'
import type { ConnectorInbox, DeliveryBody, EnqueueResult } from './connector-inbox.js'
import type { ConnectorThreads, NewThread } from './connector-threads.js'

export type QueueResult = EnqueueResult | 'unknown_host' | 'not_this_hosts_thread'

// One host-locked transaction finds the host, binds the thread and queues, so per-host seq is
// assigned in order.
export async function queueDelivery(
  deps: {
    database: CloudDatabase
    inbox: ConnectorInbox
    threads: ConnectorThreads
    hosts: ConnectorHosts
  },
  input: { thread: Omit<NewThread, 'accountId'>; deliveryId: string; body: DeliveryBody }
): Promise<QueueResult> {
  const { hostId, externalId } = input.thread
  return await deps.database.transaction(async (transaction) => {
    await lockConnectorHost(transaction, hostId)
    const accountId = await deps.hosts.accountOf(transaction, hostId)
    if (!accountId) {
      return 'unknown_host'
    }
    if (!(await deps.threads.bind(transaction, { ...input.thread, accountId }))) {
      return 'not_this_hosts_thread'
    }
    return await deps.inbox.enqueue(transaction, {
      hostId,
      externalId,
      deliveryId: input.deliveryId,
      body: input.body
    })
  })
}
