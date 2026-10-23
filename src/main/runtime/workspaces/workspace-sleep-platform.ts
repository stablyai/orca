import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/**
 * What only the desktop can do in a workspace's sleep: reach the paired servers that run its
 * terminals or chats, and suspend its VM. A headless server gets none and refuses those parts.
 */
export type WorkspaceSleepPlatform = {
  callEnvironment: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
  suspendVm: (workspaceId: string) => Promise<void>
}
