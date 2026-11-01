import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/** Desktop-only access to paired hosts and VM suspension; headless servers refuse those portions. */
export type WorkspaceSleepPlatform = {
  callEnvironment: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
  suspendVm: (workspaceId: string) => Promise<void>
}
