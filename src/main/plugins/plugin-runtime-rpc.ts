import { randomUUID } from 'node:crypto'
import { RpcDispatcher, type DispatcherOptions } from '../runtime/rpc/dispatcher'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PluginRuntimeRpc } from './workers/host-api/plugin-host-runtime-call'
import { agentLaunchMethod } from '../runtime/rpc/methods/agent-launch/agent-launch'

/** An error the runtime answered, with its code (`selector_not_found`, ...); `cause` is what the
 *  handler threw, for callers that tell refusals apart by class. */
export class PluginRuntimeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

/**
 * The runtime methods the `orca` CLI calls, dispatched in process with the CLI's identity, so a
 * plugin's workspace actions run the same code on the host that owns the workspace.
 */
export function pluginRuntimeRpc(
  runtime: OrcaRuntimeService,
  methods: DispatcherOptions['methods']
): PluginRuntimeRpc {
  let dispatcher: RpcDispatcher | null = null
  return async (method, params, options = {}) => {
    // Keep the caller's refusal intact even when a handler rechecks it after an await.
    let refusal: unknown = null
    let thrown: unknown
    const beforeEffect = (): void => {
      try {
        options.signal?.throwIfAborted()
        options.beforeEffect?.()
      } catch (error) {
        refusal = error
        throw error
      }
    }
    const callDispatcher =
      method === 'agent.launch' && (options.onAgentLaunchSurfacePublished || options.beforeEffect)
        ? new RpcDispatcher({
            runtime,
            methods: methods.map((entry) =>
              entry.name === 'agent.launch'
                ? agentLaunchMethod({
                    onSurfacePublished: options.onAgentLaunchSurfacePublished,
                    beforeEffect
                  })
                : entry
            )
          })
        : (dispatcher ??= new RpcDispatcher({ runtime, methods }))
    const response = await callDispatcher.dispatch(
      { id: randomUUID(), authToken: 'plugin-host', method, params },
      {
        // Why the CLI's identity: a mod's action is automation, as an agent's `orca` call is.
        caller: { kind: 'local-cli' },
        ...(options.plugin
          ? { plugin: { ...options.plugin, assertActive: () => options.beforeEffect?.() } }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        beforeInvoke: beforeEffect,
        onHandlerError: (error) => {
          thrown = error
        }
      }
    )
    if (refusal !== null) {
      throw refusal
    }
    if (!response.ok) {
      throw new PluginRuntimeRpcError(
        response.error.code,
        response.error.message,
        thrown === undefined ? undefined : { cause: thrown }
      )
    }
    return response.result
  }
}
