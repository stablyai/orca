import { defineMethod, defineStreamingMethod } from '../core'
import { AGENT_STATUS_STORE_REPLICA_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentStatusStoreFrame } from '../../../../shared/agent-status-store-replication'

function requirePublisher(runtime: {
  getAgentStatusStorePublisher: () => {
    snapshot: () => AgentStatusStoreFrame
    subscribe: (emit: (frame: AgentStatusStoreFrame) => void) => () => void
  } | null
}) {
  const publisher = runtime.getAgentStatusStorePublisher()
  if (!publisher) {
    throw new Error('agent_status_store_unavailable')
  }
  return publisher
}

export const AGENT_STATUS_STORE_METHODS = [
  defineMethod({
    name: 'agentStatus.getStoreSnapshot',
    params: null,
    handler: (_params, { runtime, clientCapabilities }) => {
      if (!clientCapabilities?.includes(AGENT_STATUS_STORE_REPLICA_CAPABILITY)) {
        throw new Error('agent_status_store_capability_required')
      }
      return requirePublisher(runtime).snapshot()
    }
  }),
  defineStreamingMethod({
    name: 'agentStatus.subscribeStore',
    params: null,
    handler: async (_params, { runtime, clientCapabilities, signal }, emit) => {
      if (!clientCapabilities?.includes(AGENT_STATUS_STORE_REPLICA_CAPABILITY)) {
        throw new Error('agent_status_store_capability_required')
      }
      if (!signal) {
        throw new Error('agent_status_store_subscription_signal_required')
      }
      if (signal.aborted) {
        return
      }
      const publisher = requirePublisher(runtime)
      let resolveAbort = (): void => {}
      const aborted = new Promise<void>((resolve) => {
        resolveAbort = resolve
      })
      signal.addEventListener('abort', resolveAbort, { once: true })
      const unsubscribe = publisher.subscribe(emit)
      try {
        if (signal.aborted) {
          resolveAbort()
        }
        await aborted
      } finally {
        signal.removeEventListener('abort', resolveAbort)
        unsubscribe()
      }
    }
  })
] as const
