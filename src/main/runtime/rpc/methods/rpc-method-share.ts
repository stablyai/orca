// What a teammate's Orca may ask a shared host, read off each method's own `share` decision.
import type { BotShareMethodAccess } from '../../../../shared/bots/bot-share-rpc-methods'
import { ALL_RPC_METHODS } from './rpc-method-registry'

export type RpcMethodName = (typeof ALL_RPC_METHODS)[number]['name']

type SharedMethod = { name: RpcMethodName; access: BotShareMethodAccess; stream: boolean }

// Read on first use: method modules load before the registry is complete.
let shared: ReadonlyMap<string, SharedMethod> | null = null

function sharedMethods(): ReadonlyMap<string, SharedMethod> {
  shared ??= new Map(
    ALL_RPC_METHODS.flatMap((method): [string, SharedMethod][] =>
      method.share === 'not-shared'
        ? []
        : [[method.name, { name: method.name, access: method.share, stream: 'stream' in method }]]
    )
  )
  return shared
}

/** The methods a share allows, by name. */
export function botShareMethodNames(): RpcMethodName[] {
  return [...sharedMethods().values()].map((method) => method.name)
}

export function isBotShareMethod(method: string): boolean {
  return sharedMethods().has(method)
}

/** A shared method that opens a stream; every other one answers once. */
export function isBotShareStreamMethod(method: string): boolean {
  return sharedMethods().get(method)?.stream === true
}
