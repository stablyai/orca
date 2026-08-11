import type { RpcClient } from './rpc-client'

// Why: stable per-instance identity so React dep keys change when forceReconnect swaps the client, re-attaching listeners.
const clientIdentities = new WeakMap<RpcClient, number>()
let nextClientIdentity = 1

export function rpcClientIdentity(client: RpcClient): number {
  let identity = clientIdentities.get(client)
  if (identity == null) {
    identity = nextClientIdentity++
    clientIdentities.set(client, identity)
  }
  return identity
}
