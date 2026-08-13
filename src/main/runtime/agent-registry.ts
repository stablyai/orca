/**
 * Agent Registry Implementation
 *
 * Maintains a registry of currently active agent sessions.
 * Provides methods to register, unregister, and query agents.
 * Implements TTL-based expiration for stale entries.
 */

import { createHmac } from 'node:crypto'
import type {
  AgentRegistryListOptions,
  AgentRegistryListResult,
  AgentRegistryRequest,
  CapabilityMethod,
  LiveAgentInfo
} from '../../shared/agent-registry'
import { AGENT_REGISTRY_CONFIG } from '../../shared/agent-registry'

/**
 * In-memory registry of live agent sessions.
 * Thread-safety: assumes single-threaded Node.js event loop usage.
 */
export class AgentRegistry {
  /**
   * Map of keyId -> agent info
   */
  private agents: Map<string, LiveAgentInfo>

  /**
   * TTL cleanup timer reference (to allow cancellation)
   */
  private ttlTimer: NodeJS.Timeout | null = null

  constructor(private options?: { cleanupIntervalMs?: number }) {
    this.agents = new Map<string, LiveAgentInfo>()
    // Start periodic TTL cleanup
    this.startTtlCleanup()
  }

  /**
   * Register an agent in the registry.
   * If an agent with the same keyId already exists, updates it.
   */
  register(request: AgentRegistryRequest): LiveAgentInfo {
    const now = Date.now()

    // Compute capability digest for integrity
    const capabilityDigest = this.computeCapabilityDigest(request.supportedMethods)

    const agent: LiveAgentInfo = {
      keyId: request.keyId,
      agentType: request.agentType,
      sessionId: request.sessionId,
      capabilities: {
        agentKeyId: request.keyId,
        supportedMethods: request.supportedMethods,
        capabilityDigest,
        declaredAt: now
      },
      lastActivityAt: now,
      metadata: request.metadata
    }

    this.agents.set(request.keyId, agent)
    return agent
  }

  /**
   * Unregister an agent from the registry.
   * Does nothing if the agent is not found.
   */
  unregister(keyId: string): void {
    this.agents.delete(keyId)
  }

  /**
   * Get a single agent by keyId.
   * Returns null if not found or if expired.
   */
  get(keyId: string): LiveAgentInfo | null {
    const agent = this.agents.get(keyId)
    if (!agent) {
      return null
    }

    // Check if expired during this query
    if (this.isExpired(agent)) {
      this.agents.delete(keyId)
      return null
    }

    return agent
  }

  /**
   * List all agents matching optional filters.
   * Lazily removes expired entries during listing.
   */
  list(options?: AgentRegistryListOptions): AgentRegistryListResult {
    const now = Date.now()
    const allAgents: LiveAgentInfo[] = []
    const expiredKeyIds: string[] = []

    // Collect non-expired agents and mark expired ones for cleanup
    for (const [keyId, agent] of this.agents) {
      if (now - agent.lastActivityAt > AGENT_REGISTRY_CONFIG.TTL_MS) {
        expiredKeyIds.push(keyId)
      } else {
        allAgents.push(agent)
      }
    }

    // Clean up expired entries
    for (const keyId of expiredKeyIds) {
      this.agents.delete(keyId)
    }

    // Apply filters if specified
    let filtered = allAgents

    if (options?.agentType) {
      filtered = filtered.filter((agent) => agent.agentType === options.agentType)
    }

    if (options?.capability) {
      filtered = filtered.filter((agent) =>
        agent.capabilities.supportedMethods.includes(options.capability!)
      )
    }

    return {
      agents: filtered,
      totalCount: allAgents.length
    }
  }

  /**
   * Update the lastActivityAt timestamp for an agent (heartbeat).
   * This keeps the agent alive in the registry.
   * Returns the updated agent, or null if not found.
   */
  heartbeat(keyId: string): LiveAgentInfo | null {
    const agent = this.agents.get(keyId)
    if (!agent) {
      return null
    }

    if (this.isExpired(agent)) {
      this.agents.delete(keyId)
      return null
    }

    agent.lastActivityAt = Date.now()
    return agent
  }

  /**
   * Clear all agents from the registry.
   * Useful for testing or clean shutdown.
   */
  clear(): void {
    this.agents.clear()
  }

  /**
   * Shut down the registry and stop TTL cleanup.
   */
  shutdown(): void {
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer)
      this.ttlTimer = null
    }
  }

  /**
   * Check if an agent has expired based on TTL.
   */
  private isExpired(agent: LiveAgentInfo): boolean {
    return Date.now() - agent.lastActivityAt > AGENT_REGISTRY_CONFIG.TTL_MS
  }

  /**
   * Compute SHA256 HMAC digest of the capability methods for integrity.
   * Format: base64url encoded, for consistency with agent keyId format.
   */
  private computeCapabilityDigest(methods: CapabilityMethod[]): string {
    const serialized = JSON.stringify(methods)
    // Use a fixed key for capability digest (this is for integrity, not authentication)
    const digest = createHmac('sha256', 'agent-registry-v1').update(serialized).digest('base64url')
    return digest
  }

  /**
   * Start periodic TTL cleanup.
   * Runs every 30 seconds to remove expired entries.
   */
  private startTtlCleanup(): void {
    const intervalMs = this.options?.cleanupIntervalMs ?? 30_000

    this.ttlTimer = setInterval(() => {
      const now = Date.now()
      const expiredKeyIds: string[] = []

      for (const [keyId, agent] of this.agents) {
        if (now - agent.lastActivityAt > AGENT_REGISTRY_CONFIG.TTL_MS) {
          expiredKeyIds.push(keyId)
        }
      }

      for (const keyId of expiredKeyIds) {
        this.agents.delete(keyId)
      }
    }, intervalMs)

    // Allow the process to exit even if this timer is running
    if (this.ttlTimer.unref) {
      this.ttlTimer.unref()
    }
  }
}

/**
 * Global singleton instance of the agent registry.
 * In a production system, this might be injected via dependency injection.
 */
let globalAgentRegistry: AgentRegistry | null = null

/**
 * Get or create the global agent registry instance.
 */
export function getGlobalAgentRegistry(): AgentRegistry {
  if (!globalAgentRegistry) {
    globalAgentRegistry = new AgentRegistry()
  }
  return globalAgentRegistry
}

/**
 * Set the global agent registry (mainly for testing).
 */
export function setGlobalAgentRegistry(registry: AgentRegistry | null): void {
  if (globalAgentRegistry) {
    globalAgentRegistry.shutdown()
  }
  globalAgentRegistry = registry
}
