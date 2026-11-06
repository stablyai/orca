import { AsyncLocalStorage } from 'node:async_hooks'
import type { RpcCallerIdentity } from './rpc-caller-identity'

// Lets code far below a handler tell an agent's CLI call from a person's relayed input.
const activeCaller = new AsyncLocalStorage<RpcCallerIdentity | undefined>()

export function runWithActiveRpcCaller<T>(caller: RpcCallerIdentity | undefined, run: () => T): T {
  return activeCaller.run(caller, run)
}

/** The caller of the RPC handler this code runs under; undefined outside any handler. */
export function getActiveRpcCaller(): RpcCallerIdentity | undefined {
  return activeCaller.getStore()
}
