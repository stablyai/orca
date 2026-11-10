import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { RpcAnyMethodDeclaration } from '../../../runtime/rpc/core'
import { RpcDispatcher } from '../../../runtime/rpc/dispatcher'

export type RpcMethods = readonly RpcAnyMethodDeclaration[]

let rpcMethods: Promise<RpcMethods> | null = null

/** The RPC table loads with the first relayed command, not on the host's startup path. */
export function loadRpcMethods(): Promise<RpcMethods> {
  rpcMethods ??= import('../../../runtime/rpc/methods/rpc-method-registry').then(
    (registry) => registry.ALL_RPC_METHODS,
    (error: unknown) => {
      rpcMethods = null
      throw error
    }
  )
  return rpcMethods
}

const dispatchers = new WeakMap<OrcaRuntimeService, RpcDispatcher>()

export function legacyRelayCliDispatcher(
  runtime: OrcaRuntimeService,
  methods: RpcMethods,
  allowed: ReadonlySet<string>
): RpcDispatcher {
  let dispatcher = dispatchers.get(runtime)
  if (!dispatcher) {
    dispatcher = new RpcDispatcher({
      runtime,
      // Restrict registration too, so upstream scope bugs cannot invoke unrelated methods.
      methods: methods.filter((method) => allowed.has(method.name)),
      callerScope: { kind: 'runtime-paired', grants: [] }
    })
    dispatchers.set(runtime, dispatcher)
  }
  return dispatcher
}
