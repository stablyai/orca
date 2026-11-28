import { randomUUID } from 'node:crypto'
import { RpcDispatcher, type DispatcherOptions } from '../../runtime/rpc/dispatcher'
import type { RpcAnyMethodDeclaration } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { HostLaunchContext } from '../../runtime/rpc/methods/agent-launch/agent-launch-surfaces'
import type { PluginRuntimeRpc } from '../workers/host-api/plugin-host-runtime-call'

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
 * A dispatcher for one call, in which `agent.launch` carries the caller's policy. Main lists the
 * method among the methods a dispatcher starts with or in one of its lazy groups, so both must
 * give the policy-bound one. Its module loads with the call, as a lazy group would load it.
 */
async function dispatcherWithLaunchPolicy(
  runtime: OrcaRuntimeService,
  config: Pick<DispatcherOptions, 'methods' | 'lazyGroups'>,
  policy: NonNullable<HostLaunchContext['agentLaunchPolicy']>
): Promise<RpcDispatcher> {
  const { agentLaunchMethod } = await import('../../runtime/rpc/methods/agent-launch/agent-launch')
  const launch = agentLaunchMethod(policy)
  const bindPolicy = (
    entries: readonly RpcAnyMethodDeclaration[]
  ): readonly RpcAnyMethodDeclaration[] =>
    entries.map((entry) => (entry.name === 'agent.launch' ? launch : entry))
  return new RpcDispatcher({
    runtime,
    methods: bindPolicy(config.methods),
    lazyGroups: config.lazyGroups?.map((group) => ({
      ...group,
      load: async () => bindPolicy(await group.load())
    }))
  })
}

/**
 * The runtime methods the `orca` CLI calls, dispatched in process with the CLI's identity, so a
 * plugin's workspace actions run the same code on the host that owns the workspace.
 */
export function pluginRuntimeRpc(
  runtime: OrcaRuntimeService,
  methods: DispatcherOptions['methods'],
  lazyGroups?: DispatcherOptions['lazyGroups']
): PluginRuntimeRpc {
  let dispatcher: RpcDispatcher | null = null
  return async (method, params, options = {}) => {
    // Keep the caller's refusal intact even when a handler rechecks it after an await.
    // The dispatcher maps a throw to an error answer; keep the original so its code reaches the plugin.
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
        ? await dispatcherWithLaunchPolicy(
            runtime,
            { methods, lazyGroups },
            { onSurfacePublished: options.onAgentLaunchSurfacePublished, beforeEffect }
          )
        : (dispatcher ??= new RpcDispatcher({ runtime, methods, lazyGroups }))
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
