import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

// One state listener per client that has offline uploads, and none once they're gone.
const watches = new Map<RpcClient, () => void>()

/** Watches exactly `clients`, calling `onConnected` when one comes back; others stop being watched. */
export function watchClientsForReconnect(
  clients: ReadonlySet<RpcClient>,
  onConnected: (client: RpcClient) => void
): void {
  for (const [client, stop] of watches) {
    if (!clients.has(client)) {
      stop()
      watches.delete(client)
    }
  }
  for (const client of clients) {
    if (!watches.has(client)) {
      watches.set(
        client,
        client.onStateChange((state) => {
          if (state === 'connected') {
            onConnected(client)
          }
        })
      )
    }
  }
}
