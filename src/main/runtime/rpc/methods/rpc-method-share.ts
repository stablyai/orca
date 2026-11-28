// What a teammate's Orca may ask a shared host, read off each method's own `share` decision.
import { ALL_RPC_METHODS } from './rpc-method-registry'

export type RpcMethodName = (typeof ALL_RPC_METHODS)[number]['name']

/** The methods a share allows, by name. */
export function botShareMethodNames(): RpcMethodName[] {
  return ALL_RPC_METHODS.filter((method) => method.share !== 'not-shared').map(
    (method) => method.name
  )
}
