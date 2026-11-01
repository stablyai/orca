import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/** Desktop access to paired hosts and VM suspend/resume; headless servers refuse those portions. */
export type WorkspaceSleepPlatform = {
  callEnvironment: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
  suspendVm: (workspaceId: string) => Promise<void>
  /** The host-side wake pairing with `suspendVm`'s host-side sleep; a no-op without a suspended VM. */
  resumeVm: (workspaceId: string) => Promise<void>
}
