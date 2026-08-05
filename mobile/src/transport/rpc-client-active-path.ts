import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'

export function clientActivePath(client: RpcClient | undefined): MobileConnectionPath {
  const logical = client as Partial<StableLogicalRpcClient> | undefined
  return typeof logical?.getActivePath === 'function' ? logical.getActivePath() : 'lan'
}
