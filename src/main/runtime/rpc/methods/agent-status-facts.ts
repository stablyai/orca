import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import type { AgentStatusFactStreamMessage } from '../../../../shared/agent-status-fact-types'

const AgentStatusFactsSubscribeParams = z
  .object({
    lastSeenSeq: z.number().int().min(0).optional(),
    epoch: z.string().min(1).optional()
  })
  .nullish()

const AgentStatusFactsUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1)
})

let agentStatusSubscriptionSeq = 0

export const AGENT_STATUS_FACT_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'agent.status.subscribe',
    params: AgentStatusFactsSubscribeParams,
    handler: async (params, { runtime, connectionId, requestId }, emit) => {
      let closed = false
      let finish: (() => void) | null = null
      const subscriptionId = `agent-status:${connectionId ?? 'local'}:${requestId ?? ++agentStatusSubscriptionSeq}`
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          finish?.()
          emit({ type: 'end' } satisfies AgentStatusFactStreamMessage)
        },
        connectionId
      )

      const subscription = runtime.onAgentStatusFact(
        (fact) => {
          if (!closed) {
            emit({ type: 'fact', fact } satisfies AgentStatusFactStreamMessage)
          }
        },
        params?.lastSeenSeq,
        params?.epoch
      )
      if (closed) {
        subscription.unsubscribe()
        return
      }

      emit({
        type: 'ready',
        subscriptionId,
        epoch: subscription.replay.epoch,
        headSeq: subscription.replay.headSeq,
        gap: subscription.replay.gap
      } satisfies AgentStatusFactStreamMessage)
      for (const fact of subscription.replay.facts) {
        if (!closed) {
          emit({ type: 'fact', fact } satisfies AgentStatusFactStreamMessage)
        }
      }

      await new Promise<void>((resolve) => {
        finish = () => {
          subscription.unsubscribe()
          resolve()
        }
      })
    }
  }),
  defineMethod({
    name: 'agent.status.unsubscribe',
    params: AgentStatusFactsUnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      const expectedPrefix = `agent-status:${connectionId ?? 'local'}:`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
