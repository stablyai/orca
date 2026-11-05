import type { RpcClient } from '../../transport/rpc-client'

// Ordinary parity reads use the same cached-null legacy input as the page's actual init.
export function legacyShellStatusFixture(client: RpcClient): RpcClient {
  return client.getShellHostStatus ? client : { ...client, getShellHostStatus: () => null }
}
