/**
 * RPC Methods for Agent Registry
 *
 * Provides the following RPC endpoints:
 * - agent.registry.register: Register an agent and its capabilities
 * - agent.registry.list: Query agents with optional filtering
 * - agent.registry.heartbeat: Send a heartbeat to keep agent alive
 * - agent.registry.unregister: Unregister an agent
 */

import { z } from 'zod'
import type {
  AgentRegistryListOptions,
  AgentRegistryListResult
} from '../../../../shared/agent-registry'
import { brandCapabilityMethod } from '../../../../shared/agent-registry'
import { getGlobalAgentRegistry } from '../../agent-registry'
import { defineMethod, type RpcAnyMethod } from '../core'

// ============================================================================
// Zod Schemas for Request/Response Validation
// ============================================================================

const CapabilityMethodSchema = z.string().min(1).max(256)

const AgentRegistryRequestSchema = z.object({
  keyId: z.string().min(1).max(256),
  agentType: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  supportedMethods: z.array(CapabilityMethodSchema),
  metadata: z.record(z.string(), z.unknown()).optional()
})

const HeartbeatParamsSchema = z.object({
  keyId: z.string().min(1).max(256)
})

const ListParamsSchema = z.object({
  agentType: z.string().min(1).max(256).optional(),
  capability: z.string().min(1).max(256).optional()
})

const UnregisterParamsSchema = z.object({
  keyId: z.string().min(1).max(256)
})

// ============================================================================
// RPC Method Handlers
// ============================================================================

/**
 * agent.registry.register
 * Register an agent session and declare its capabilities.
 */
const registerMethod = defineMethod({
  name: 'agent.registry.register',
  params: AgentRegistryRequestSchema,
  handler: (params) => {
    const registry = getGlobalAgentRegistry()
    const brandedMethods = params.supportedMethods.map(brandCapabilityMethod)
    return registry.register({
      keyId: params.keyId,
      agentType: params.agentType,
      sessionId: params.sessionId,
      supportedMethods: brandedMethods,
      metadata: params.metadata
    })
  }
})

/**
 * agent.registry.list
 * List all agents, optionally filtered by type or capability.
 */
const listMethod = defineMethod({
  name: 'agent.registry.list',
  params: ListParamsSchema,
  handler: (params): AgentRegistryListResult => {
    const registry = getGlobalAgentRegistry()
    const options: AgentRegistryListOptions = {}

    if (params.agentType) {
      options.agentType = params.agentType
    }

    if (params.capability) {
      options.capability = brandCapabilityMethod(params.capability)
    }

    return registry.list(options)
  }
})

/**
 * agent.registry.heartbeat
 * Send a heartbeat for an agent to keep it alive in the registry.
 */
const heartbeatMethod = defineMethod({
  name: 'agent.registry.heartbeat',
  params: HeartbeatParamsSchema,
  handler: (params) => {
    const registry = getGlobalAgentRegistry()
    return registry.heartbeat(params.keyId)
  }
})

/**
 * agent.registry.unregister
 * Unregister an agent from the registry.
 */
const unregisterMethod = defineMethod({
  name: 'agent.registry.unregister',
  params: UnregisterParamsSchema,
  handler: (params): { success: boolean } => {
    const registry = getGlobalAgentRegistry()
    registry.unregister(params.keyId)
    return { success: true }
  }
})

/**
 * Export all agent registry RPC methods.
 */
export const AGENT_REGISTRY_METHODS: RpcAnyMethod[] = [
  registerMethod,
  listMethod,
  heartbeatMethod,
  unregisterMethod
]
