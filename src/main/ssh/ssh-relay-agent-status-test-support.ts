import type { RelayDispatcher } from '../../relay/dispatcher'
import type {
  AgentStatusStoreFrame,
  AgentStatusStoreSnapshot
} from '../../shared/agent-status-store-replication'
import {
  AGENT_STATUS_STORE_FRAME_NOTIFICATION,
  AGENT_STATUS_STORE_REPLICA_CAPABILITY,
  AGENT_STATUS_STORE_SNAPSHOT_METHOD,
  AGENT_STATUS_STORE_SUBSCRIBE_METHOD
} from '../../shared/agent-status-store-replication'

export function registerFakeAgentStatusRelayHandlers(
  dispatcher: RelayDispatcher,
  options: { statusSnapshot?: AgentStatusStoreSnapshot },
  onSubscribed: () => void
): void {
  dispatcher.onRequest(AGENT_STATUS_STORE_SNAPSHOT_METHOD, async (params) => {
    if (params.capability !== AGENT_STATUS_STORE_REPLICA_CAPABILITY) {
      throw new Error('agent_status_store_capability_required')
    }
    if (!options.statusSnapshot) {
      throw Object.assign(new Error('Method not found'), { code: -32601 })
    }
    return options.statusSnapshot
  })
  dispatcher.onRequest(AGENT_STATUS_STORE_SUBSCRIBE_METHOD, async (params) => {
    if (params.capability !== AGENT_STATUS_STORE_REPLICA_CAPABILITY) {
      throw new Error('agent_status_store_capability_required')
    }
    onSubscribed()
    return { subscribed: true }
  })
}

export function notifyFakeAgentStatusFrame(
  dispatcher: RelayDispatcher,
  subscribed: boolean,
  frame: AgentStatusStoreFrame
): void {
  if (subscribed) {
    dispatcher.notify(AGENT_STATUS_STORE_FRAME_NOTIFICATION, frame)
  }
}
