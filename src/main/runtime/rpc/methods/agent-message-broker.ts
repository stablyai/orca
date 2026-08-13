/**
 * RPC Methods for Agent Message Broker (P0-2)
 *
 * Provides the following RPC endpoint:
 * - agent.message.send: Send a message from one registered agent to another,
 *   addressed by keyId.
 *
 * Only a send method ships in this phase — see the scope note at the top of
 * src/main/runtime/agent-message-broker.ts for why a subscribe/streaming RPC
 * surface is deliberately not part of P0-2.
 */

import { z } from 'zod'
import type { AgentMessageSendResult } from '../../../../shared/agent-message-broker'
import { getGlobalAgentMessageBroker } from '../../agent-message-broker'
import { defineMethod, type RpcAnyMethod } from '../core'

// ============================================================================
// Zod Schemas for Request/Response Validation
// ============================================================================

const AgentMessageSendParamsSchema = z.object({
  sourceKeyId: z.string().min(1).max(256),
  targetKeyId: z.string().min(1).max(256),
  payload: z.unknown()
})

// ============================================================================
// RPC Method Handlers
// ============================================================================

/**
 * agent.message.send
 * Send a message to another registered agent, addressed by keyId.
 * Never throws for a routing miss (unknown target / no subscriber) — those
 * are reported as a typed status on the result, not an RPC error, so a
 * caller can distinguish "your request was malformed" from "the target
 * just isn't reachable right now".
 */
const sendMethod = defineMethod({
  name: 'agent.message.send',
  params: AgentMessageSendParamsSchema,
  handler: (params): AgentMessageSendResult => {
    const broker = getGlobalAgentMessageBroker()
    return broker.send({
      sourceKeyId: params.sourceKeyId,
      targetKeyId: params.targetKeyId,
      payload: params.payload
    })
  }
})

/**
 * Export all agent message broker RPC methods.
 */
export const AGENT_MESSAGE_BROKER_METHODS: RpcAnyMethod[] = [sendMethod]
