import { recordRuntimeEnvironmentUsage } from '../../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import type * as Rpc from '../../../shared/runtime-rpc-envelope'

/** A successful answer records which server process served the environment. */
export function markEnvironmentUsedFromResponse(
  userDataPath: string,
  environmentId: string,
  response: Rpc.RuntimeRpcResponse<unknown>
): void {
  if (response.ok === true) {
    recordRuntimeEnvironmentUsage(userDataPath, environmentId, {
      runtimeId: response._meta.runtimeId
    })
  }
}
