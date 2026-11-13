import { recordRuntimeEnvironmentUsage } from '../../../../shared/remote-runtime/host-store/runtime-environment-usage-record'
import type * as Rpc from '../../../../shared/runtime-rpc-envelope'

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

export function shouldUseCachedRequestConnection(method: string): boolean {
  return method === 'terminal.send' || method === 'terminal.updateViewport'
}
