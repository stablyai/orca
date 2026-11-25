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
  /** Holds a message the host refused again, under a new id; false when nothing was held. */
  sendAgain: (args: { environmentId: string; clientMessageId: string }) => Promise<boolean>
  subscribe: (
    args: { environmentId: string; method: string; params?: unknown },
    callback: (response: RuntimeRpcResponse<unknown>) => void
  ) => Promise<{ unsubscribe: () => void }>
}
