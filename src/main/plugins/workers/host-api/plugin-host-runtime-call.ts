import type { PluginErrorCode } from '../../../../shared/plugins/frames/plugin-protocol'
import type { PluginHostMethodContext } from './plugin-host-method-bind'
import type { PluginHostServices } from './plugin-host-method-bindings'
import { PluginHostCallError } from './plugin-host-call-scope'
import type { PluginHostRendererActions } from '../../view/plugin-host-renderer-actions'

/** The runtime RPC the `orca` CLI calls, run in process; rejects with the runtime's error.
 *  `beforeEffect` runs right before the runtime acts, after its own waits; a throw refuses it. */
export type PluginRuntimeRpc = (
  method: string,
  params: unknown,
  options?: { signal?: AbortSignal; beforeEffect?: () => void }
) => Promise<unknown>

const NO_LIVE_TERMINAL: [PluginErrorCode, string] = [
  'action_failed',
  'no live terminal has this id'
]

// Runtime refusals whose wording names Orca internals; a plugin gets a fixed message instead.
const RUNTIME_FAILURES: ReadonlyMap<string, [PluginErrorCode, string]> = new Map([
  ['selector_not_found', ['action_failed', 'no workspace has this id']],
  [
    'selector_ambiguous',
    ['action_failed', 'two hosts have a workspace with this id; use the id workspace.list gives']
  ],
  ['terminal_not_found', NO_LIVE_TERMINAL],
  ['terminal_handle_stale', NO_LIVE_TERMINAL],
  ['terminal_exited', NO_LIVE_TERMINAL],
  ['terminal_gone', NO_LIVE_TERMINAL],
  ['runtime_unavailable', ['unavailable', 'this Orca host cannot run workspace actions now']]
])

/** A runtime refusal as the plugin sees it; anything unrecognized passes through unchanged. */
export function pluginRuntimeFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof PluginHostCallError) {
    return error
  }
  // The runtime answers a code (`selector_not_found`); some refusals arrive as a bare message.
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  const known = (code && RUNTIME_FAILURES.get(code)) || RUNTIME_FAILURES.get(error.message)
  return known ? new PluginHostCallError(known[0], known[1]) : error
}

export function pluginHostRenderer(services: PluginHostServices): PluginHostRendererActions {
  if (!services.renderer) {
    throw new PluginHostCallError('unavailable', 'only the Orca desktop app can do this')
  }
  return services.renderer
}

/** The runtime RPC, with its refusals mapped by `pluginRuntimeFailure`. */
export function pluginHostRpc(services: PluginHostServices): PluginRuntimeRpc {
  const call = services.runtimeRpc
  if (!call) {
    throw new PluginHostCallError('unavailable', 'this Orca host cannot run workspace actions')
  }
  return (method, params, options) =>
    call(method, params, options).catch((error: unknown) => {
      throw pluginRuntimeFailure(error)
    })
}

/** A runtime call that changes something: refused if the plugin lost approval, or its worker
 *  cancelled the call, at any point before the runtime acts. */
export function pluginHostEffect(
  ctx: PluginHostMethodContext,
  method: string,
  params: unknown
): Promise<unknown> {
  ctx.scope.assertActive()
  return pluginHostRpc(ctx.services)(method, params, {
    ...(ctx.scope.signal ? { signal: ctx.scope.signal } : {}),
    beforeEffect: () => ctx.scope.assertActive()
  })
}

/**
 * The selector a listed workspace id names. Ids carry their host (`identity:`, unique across
 * twins on two hosts) or are folder keys; a bare id from elsewhere is taken as an exact id.
 */
export function pluginWorkspaceSelector(workspaceId: string): string {
  return workspaceId.startsWith('identity:') ? workspaceId : `id:${workspaceId}`
}
