import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'

/** Desktop access to paired hosts and VM suspend/resume; headless servers refuse those portions. */
export type WorkspaceSleepPlatform = {
  callEnvironment: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
  /** Whether this host holds a recipe VM for the workspace. */
  ownsVm: (workspaceId: string) => boolean
  suspendVm: (workspaceId: string) => Promise<void>
  /** Resumes the VM if it is suspended; null when the workspace has none. */
  resumeVm: (workspaceId: string) => Promise<EphemeralVmRuntimeRecord | null>
}
