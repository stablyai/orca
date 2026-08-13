/**
 * RPC Methods for Agent Consent (P1-1)
 *
 * Provides the following RPC endpoint:
 * - agent.consent.record: Record a user decision about whether one agent
 *   type may message another through the P0-2 broker (agent.message.send).
 *
 * Recording is the only RPC surface this phase adds — reading/rendering
 * consent state is the future P1-2 consent dialog's job, out of scope here
 * (see the task's scope boundary note). AgentMessageBroker.send() itself
 * queries the store directly, in-process, the same way it already queries
 * the P0-1 registry directly rather than through an RPC self-call.
 */

import { z } from 'zod'
import type { AgentConsentRecord } from '../../../../shared/agent-consent'
import { getGlobalAgentConsentStore } from '../../agent-consent-store'
import { defineMethod, type RpcAnyMethod } from '../core'

// ============================================================================
// Zod Schemas for Request/Response Validation
// ============================================================================

const AgentConsentRecordParamsSchema = z.object({
  sourceAgentType: z.string().min(1).max(256),
  targetAgentType: z.string().min(1).max(256),
  decision: z.enum(['allow', 'deny'])
})

// ============================================================================
// RPC Method Handlers
// ============================================================================

/**
 * agent.consent.record
 * Record (or overwrite) the user's decision for whether sourceAgentType may
 * message targetAgentType.
 */
const recordMethod = defineMethod({
  name: 'agent.consent.record',
  params: AgentConsentRecordParamsSchema,
  handler: (params): AgentConsentRecord => {
    const store = getGlobalAgentConsentStore()
    return store.record({
      sourceAgentType: params.sourceAgentType,
      targetAgentType: params.targetAgentType,
      decision: params.decision
    })
  }
})

/**
 * Export all agent consent RPC methods.
 */
export const AGENT_CONSENT_METHODS: RpcAnyMethod[] = [recordMethod]
