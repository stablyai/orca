// One stream per voice attempt: closing it from either end stops the provider's voice session.

import { defineMethod, defineStreamingMethod } from '../../../core'
import { requireStructuredSessionHost as requireSessionHost } from '../creation/structured-agent-session-gate'
import {
  CodexVoicesParams,
  VoiceConversationParams
} from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-voice-params'
import { structuredAgentSessionSubscriptionId } from '../subscriptions/structured-agent-session-subscription-id'
import { bindStructuredAgentSessionStream } from '../subscriptions/structured-agent-session-status-stream'
import type {
  AgentSessionCodexVoices,
  AgentSessionVoiceEvent
} from '../../../../../../shared/agent-session/agent-session-voice-conversation'

export const STRUCTURED_AGENT_SESSION_VOICE_METHODS = [
  defineMethod({
    name: 'agentSession.codexVoices',
    permission: 'workspace',
    params: CodexVoicesParams,
    handler: async (params, ctx): Promise<AgentSessionCodexVoices> => ({
      voices:
        (await requireSessionHost(ctx, params.sessionId).deps.adapter.listVoiceConversationVoices?.(
          params.sessionId
        )) ?? null
    })
  }),
  defineStreamingMethod({
    name: 'agentSession.voiceConversation',
    permission: 'workspace',
    params: VoiceConversationParams,
    handler: async (params, ctx, emit) => {
      const host = requireSessionHost(ctx, params.sessionId)
      let handle: { stop: () => void } | undefined
      let ended = false
      const stream = bindStructuredAgentSessionStream(
        ctx,
        `${structuredAgentSessionSubscriptionId(ctx, params.sessionId)}:voice`,
        () => handle?.stop()
      )
      if (stream.isClosed()) {
        return
      }
      const deliver = (event: AgentSessionVoiceEvent): void => {
        if (ended) {
          return
        }
        let delivered = true
        try {
          emit(event)
        } catch {
          // The caller is gone; its stream close still stops the provider's session.
          delivered = false
        }
        if (!delivered || event.type === 'ended' || event.type === 'refused') {
          ended = true
          stream.close()
        }
      }
      // The router answers for every agent: a resting chat or another agent is refused there.
      handle = host.deps.adapter.startVoiceConversation?.({
        sessionId: params.sessionId,
        offerSdp: params.offerSdp,
        ...(params.voice ? { voice: params.voice } : {}),
        emit: deliver
      })
      if (!handle) {
        deliver({ type: 'refused', reason: 'unsupported' })
      } else if (stream.isClosed()) {
        handle.stop()
      }
    }
  })
]
