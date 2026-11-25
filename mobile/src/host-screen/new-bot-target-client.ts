import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { rpcClientForExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

/** The client a new bot is made through: the paired desktop's, or the relayed server's. A server that
 *  dropped out while the sheet is open gets none, never the paired desktop's. */
export function newBotTargetClient(args: {
  client: RpcClient | null
  hostCapabilities: readonly string[]
  /** The Bots section's host id; a server's is `runtime:…`. */
  target: string | null
  servers: readonly { hostId: ExecutionHostId }[]
}): RpcClient | null {
  const { client, target } = args
  if (!client || !target) {
    return null
  }
  if (target === LOCAL_EXECUTION_HOST_ID) {
    return rpcClientForExecutionHost(client, args.hostCapabilities, undefined)
  }
  const server = args.servers.find((host) => host.hostId === target)
  return server ? rpcClientForExecutionHost(client, args.hostCapabilities, server.hostId) : null
}
