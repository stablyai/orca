import { orderHostsByIds } from './host-list-order'
import { mutateStoredHosts } from './host-list-mutation-queue'

/** Change only the latest metadata array's display order under its existing mutation queue. */
export async function reorderHosts(orderedIds: readonly string[]): Promise<void> {
  await mutateStoredHosts((hosts) => {
    const next = orderHostsByIds(hosts, orderedIds)
    return next.every((host, index) => host === hosts[index]) ? hosts : next
  })
}
