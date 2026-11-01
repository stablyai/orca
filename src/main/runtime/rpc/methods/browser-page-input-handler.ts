import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

/** Handles a click or key press on a page, naming the paired client any link it opens belongs to. */
export function browserPageInputHandler<TParams extends { page?: string }, TResult>(
  command: (runtime: OrcaRuntimeService, params: TParams) => Promise<TResult>
): (params: TParams, context: RpcContext) => Promise<TResult> {
  return (params, { runtime, pairedDeviceId, clientKind }) =>
    runtime.offscreenBrowserPageLinks.deliverInput(
      params.page,
      { pairedDeviceId, clientKind },
      () => command(runtime, params)
    )
}
