import type { SharedBotHostView } from '../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'

/** The agents shared with this Orca account, and calls to their hosts over Orca Relay. */
export type SharedBotHostsApi = {
  list: () => Promise<SharedBotHostView[]>
  onChanged: (callback: (views: SharedBotHostView[]) => void) => () => void
  call: (args: {
    environmentId: string
    method: string
    params?: unknown
  }) => Promise<RuntimeRpcResponse<unknown>>
  subscribe: (
    args: { environmentId: string; method: string; params?: unknown },
    callback: (response: RuntimeRpcResponse<unknown>) => void
  ) => Promise<{ unsubscribe: () => void }>
}
