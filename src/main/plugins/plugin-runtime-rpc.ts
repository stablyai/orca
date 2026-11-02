import { randomUUID } from 'node:crypto'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PluginRuntimeRpc } from './workers/plugin-host-workspace-method-bindings'

/** An error the runtime answered, with its code (`selector_not_found`, ...). */
export class PluginRuntimeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/**
 * The runtime methods the `orca` CLI calls, dispatched in process with the CLI's identity, so a
 * plugin's workspace actions run the same code on the host that owns the workspace.
 */
export function pluginRuntimeRpc(runtime: OrcaRuntimeService): PluginRuntimeRpc {
  let dispatcher: RpcDispatcher | null = null
  return async (method, params) => {
    dispatcher ??= new RpcDispatcher({ runtime })
    const response = await dispatcher.dispatch(
      { id: randomUUID(), authToken: 'plugin-host', method, params },
      // Why the CLI's identity: a mod's action is automation, as an agent's `orca` call is.
      { caller: { kind: 'local-cli' } }
    )
    if (!response.ok) {
      throw new PluginRuntimeRpcError(response.error.code, response.error.message)
    }
    return response.result
  }
}
