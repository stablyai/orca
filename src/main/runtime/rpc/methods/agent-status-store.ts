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
      const publisher = requirePublisher(runtime)
      let unsubscribe = (): void => {}
      const abort = (): void => unsubscribe()
      unsubscribe = publisher.subscribe(emit)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
      }
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true })
        if (!signal) {
          resolve()
        }
      })
      signal?.removeEventListener('abort', abort)
      unsubscribe()
    }
  })
] as const
