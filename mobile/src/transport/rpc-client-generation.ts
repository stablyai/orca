import type { RpcClient } from './rpc-client'

type GenerationAwareRpcClient = RpcClient & { getGeneration?: () => number }

export function readRpcClientGeneration(client: RpcClient | null): number | null {
  return (client as GenerationAwareRpcClient | null)?.getGeneration?.() ?? null
}
