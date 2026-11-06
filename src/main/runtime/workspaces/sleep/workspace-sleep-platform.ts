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
  /** What a wake must honour from the moment it was accepted, before it waits its turn. */
  acceptWake: (workspaceId: string) => VmWakeRequest
  /** Resumes the VM if it is suspended; null when the workspace has none. */
  resumeVm: (
    workspaceId: string,
    request: VmWakeRequest
  ) => Promise<EphemeralVmRuntimeRecord | null>
}

/** What the user had asked of the VM's SSH host when the wake was accepted. The wake must not
 *  reconnect a host the user held disconnected then (`sshHeld`), nor one they disconnected while
 *  the wake waited or ran (a later `sshUserDisconnects`). */
export type VmWakeRequest = { sshHeld: boolean; sshUserDisconnects: number }
