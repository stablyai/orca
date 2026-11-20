// The browser routes a unary call takes before its own handler: a page a paired desktop hosts for
// this host, or (on orcad) the desktop that serves this host's CLI browser commands.
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext, RpcRequest } from '../core'
import { recordRuntimeFeatureInteraction } from './runtime-feature-interaction'

export async function routeDispatchedBrowserRpc(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  params: unknown,
  context: RpcContext
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  // Runtime test fakes may omit client-hosted browser routing.
  const clientHosted = await (runtime.routeClientHostedBrowserRpc?.(
    request.method,
    params,
    context.caller
  ) ?? { handled: false as const })
  if (clientHosted.handled) {
    recordRuntimeFeatureInteraction(
      runtime,
      request.method,
      clientHosted.result,
      undefined,
      request.params
    )
    return clientHosted
  }
  return (
    (await runtime.routeDesktopBrowserBridgeRpc?.(request.method, params, context)) ?? {
      handled: false
    }
  )
}
