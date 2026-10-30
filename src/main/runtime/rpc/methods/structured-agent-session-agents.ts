// Negotiate registered-agents.v1 for this build's declared agent capabilities; older clients know only Claude/Codex.
// subscribeAvailability separately negotiates complete health snapshots from one shared host resource.

import type { AgentSessionAgentsResult } from '../../../../shared/agent-session/agent-session-registered-agents'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../../shared/agent-session/agent-session-registered-agents'
import {
  AGENT_SESSION_AVAILABILITY_METHOD,
  type AgentSessionAvailabilityFrame
} from '../../../../shared/agent-session-agent-availability'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../../structured-agent-runtime-metadata'
import { defineMethod, defineStreamingMethod } from '../core'
import { requireStructuredCapability } from './structured-agent-session-gate'
import { AgentsParams, AvailabilityParams } from './structured-agent-session-schemas'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { structuredAgentSessionAvailabilitySubscriptionId } from './structured-agent-session-subscription-id'

export const STRUCTURED_AGENT_SESSION_AGENTS_METHODS = [
  defineMethod({
    name: AGENT_SESSION_AGENTS_METHOD,
    permission: 'workspace',
    params: AgentsParams,
    // Read build-time registrations without installing the host, matching createSupport.
    handler: async (_params, ctx): Promise<AgentSessionAgentsResult> => {
      requireStructuredCapability(ctx)
      return {
        agents: STRUCTURED_AGENT_RUNTIME_METADATA.filter(({ definition }) =>
          clientReadsStructuredSessionAgent(ctx, definition.agent)
        ).map(({ definition }) => ({
          agent: definition.agent,
          capabilities: { ...definition.capabilities },
          ...(definition.managedRuntime?.() ? { managedRuntime: true as const } : {})
        }))
      }
    }
  }),
  defineStreamingMethod({
    name: AGENT_SESSION_AVAILABILITY_METHOD,
    permission: 'workspace',
    params: AvailabilityParams,
    handler: async (_params, ctx, emit) => {
      requireStructuredCapability(ctx)
      const subscriptionId = structuredAgentSessionAvailabilitySubscriptionId(ctx)
      let release = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => release())
      if (stream.isClosed()) {
        return
      }
      release = ctx.runtime.subscribeStructuredAgentAvailability((agents) => {
        const frame: AgentSessionAvailabilityFrame = {
          type: 'availability',
          // Expose only agents the client can open.
          agents: agents.filter(({ agent }) => clientReadsStructuredSessionAgent(ctx, agent))
        }
        emit(frame)
      })
      // A replayed snapshot can close the transport before `release` was assigned.
      if (stream.isClosed()) {
        release()
      }
    }
  })
] as const
