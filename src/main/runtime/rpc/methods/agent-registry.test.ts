/**
 * Unit tests for Agent Registry RPC methods
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentRegistry, setGlobalAgentRegistry } from '../../agent-registry'
import { AGENT_REGISTRY_METHODS } from './agent-registry'
import { AGENT_REGISTRY_CONFIG } from '../../../../shared/agent-registry'

describe('Agent Registry RPC Methods', () => {
  let registry: AgentRegistry
  let registerHandler: unknown
  let listHandler: unknown
  let heartbeatHandler: unknown
  let unregisterHandler: unknown

  beforeEach(() => {
    registry = new AgentRegistry({ cleanupIntervalMs: 100 })
    setGlobalAgentRegistry(registry)

    // Extract handlers from method definitions
    registerHandler = AGENT_REGISTRY_METHODS.find(
      (m) => m.name === 'agent.registry.register'
    )?.handler
    listHandler = AGENT_REGISTRY_METHODS.find((m) => m.name === 'agent.registry.list')?.handler
    heartbeatHandler = AGENT_REGISTRY_METHODS.find(
      (m) => m.name === 'agent.registry.heartbeat'
    )?.handler
    unregisterHandler = AGENT_REGISTRY_METHODS.find(
      (m) => m.name === 'agent.registry.unregister'
    )?.handler
  })

  afterEach(() => {
    registry.shutdown()
    setGlobalAgentRegistry(null)
  })

  describe('agent.registry.register', () => {
    it('should register an agent via RPC', () => {
      const handler = registerHandler as (params: unknown) => unknown
      const result = handler({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: ['terminal.ensureAgentSession', 'file.read']
      })

      expect((result as any).keyId).toBe('test-key-1')
      expect((result as any).agentType).toBe('pi')
      expect((result as any).sessionId).toBe('session-123')
      expect((result as any).capabilities.supportedMethods).toHaveLength(2)
    })

    it('should handle empty supportedMethods', () => {
      const handler = registerHandler as (params: unknown) => unknown
      const result = handler({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      expect((result as any).capabilities.supportedMethods).toHaveLength(0)
    })

    it('should include metadata in registration', () => {
      const handler = registerHandler as (params: unknown) => unknown
      const metadata = { worktreeId: 'wt-123', connectionId: 'conn-456' }
      const result = handler({
        keyId: 'test-key-1',
        agentType: 'prime-agent',
        sessionId: 'session-123',
        supportedMethods: [],
        metadata
      })

      expect((result as any).metadata).toEqual(metadata)
    })
  })

  describe('agent.registry.list', () => {
    beforeEach(() => {
      const handler = registerHandler as (params: unknown) => unknown
      handler({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: ['file.read', 'file.write']
      })
      handler({
        keyId: 'key-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: ['terminal.ensureAgentSession']
      })
      handler({
        keyId: 'key-3',
        agentType: 'pi',
        sessionId: 'session-3',
        supportedMethods: []
      })
    })

    it('should list all agents when no filter provided', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({}) as any
      expect(result.agents).toHaveLength(3)
      expect(result.totalCount).toBe(3)
    })

    it('should filter by agentType', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({ agentType: 'pi' }) as any
      expect(result.agents).toHaveLength(2)
      expect(result.agents.every((a: any) => a.agentType === 'pi')).toBe(true)
    })

    it('should filter by capability', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({ capability: 'file.read' }) as any
      expect(result.agents).toHaveLength(1)
      expect(result.agents[0].keyId).toBe('key-1')
    })

    it('should return empty array for non-matching filter', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({ agentType: 'non-existent-type' }) as any
      expect(result.agents).toHaveLength(0)
      expect(result.totalCount).toBe(3)
    })

    it('should filter by non-existent capability', () => {
      const handler = listHandler as (params: unknown) => unknown
      const result = handler({ capability: 'non.existent' }) as any
      expect(result.agents).toHaveLength(0)
    })

    it('should combine agentType and capability filters', () => {
      // Add another agent with different type but same capability
      const handler = registerHandler as (params: unknown) => unknown
      handler({
        keyId: 'key-4',
        agentType: 'codex',
        sessionId: 'session-4',
        supportedMethods: ['file.read']
      })

      const listHandlerFunc = listHandler as (params: unknown) => unknown
      const result = listHandlerFunc({ agentType: 'pi', capability: 'file.read' }) as any
      expect(result.agents).toHaveLength(1)
      expect(result.agents[0].keyId).toBe('key-1')
      expect(result.agents[0].agentType).toBe('pi')
    })
  })

  describe('agent.registry.heartbeat', () => {
    beforeEach(() => {
      const handler = registerHandler as (params: unknown) => unknown
      handler({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })
    })

    it('should send heartbeat for existing agent', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const registered = registry.get('test-key-1')
      const originalActivityAt = (registered as any)?.lastActivityAt

      vi.advanceTimersByTime(5000)

      const handler = heartbeatHandler as (params: unknown) => unknown
      const result = handler({ keyId: 'test-key-1' }) as any
      expect(result).not.toBeNull()
      expect(result.lastActivityAt).toBeGreaterThan(originalActivityAt)

      vi.useRealTimers()
    })

    it('should return null for non-existent agent', () => {
      const handler = heartbeatHandler as (params: unknown) => unknown
      const result = handler({ keyId: 'non-existent' })
      expect(result).toBeNull()
    })

    it('should return null for expired agent', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS + 1000)

      const handler = heartbeatHandler as (params: unknown) => unknown
      const result = handler({ keyId: 'test-key-1' })
      expect(result).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('agent.registry.unregister', () => {
    beforeEach(() => {
      const handler = registerHandler as (params: unknown) => unknown
      handler({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })
    })

    it('should unregister an agent', () => {
      expect(registry.get('test-key-1')).not.toBeNull()

      const handler = unregisterHandler as (params: unknown) => unknown
      const result = handler({ keyId: 'test-key-1' }) as any
      expect(result.success).toBe(true)

      expect(registry.get('test-key-1')).toBeNull()
    })

    it('should handle unregistering non-existent agent gracefully', () => {
      const handler = unregisterHandler as (params: unknown) => unknown
      const result = handler({ keyId: 'non-existent' }) as any
      expect(result.success).toBe(true)
    })
  })

  describe('integration scenarios', () => {
    it('should handle agent lifecycle: register -> list -> heartbeat -> unregister', () => {
      // Register
      const registerHandlerFunc = registerHandler as (params: unknown) => unknown
      const registered = registerHandlerFunc({
        keyId: 'lifecycle-key',
        agentType: 'pi',
        sessionId: 'session-lifecycle',
        supportedMethods: ['file.read']
      }) as any
      expect(registered.keyId).toBe('lifecycle-key')

      // List and find
      const listHandlerFunc = listHandler as (params: unknown) => unknown
      let listResult = listHandlerFunc({ agentType: 'pi' }) as any
      expect(listResult.agents.some((a: any) => a.keyId === 'lifecycle-key')).toBe(true)

      // Heartbeat
      const heartbeatHandlerFunc = heartbeatHandler as (params: unknown) => unknown
      const heartbeatenResult = heartbeatHandlerFunc({ keyId: 'lifecycle-key' })
      expect(heartbeatenResult).not.toBeNull()

      // List again
      listResult = listHandlerFunc({}) as any
      expect(listResult.agents.some((a: any) => a.keyId === 'lifecycle-key')).toBe(true)

      // Unregister
      const unregisterHandlerFunc = unregisterHandler as (params: unknown) => unknown
      const unregisterResult = unregisterHandlerFunc({ keyId: 'lifecycle-key' }) as any
      expect(unregisterResult.success).toBe(true)

      // List and verify removed
      listResult = listHandlerFunc({}) as any
      expect(listResult.agents.some((a: any) => a.keyId === 'lifecycle-key')).toBe(false)
    })

    it('should handle multiple agents simultaneously', () => {
      const registerHandlerFunc = registerHandler as (params: unknown) => unknown
      registerHandlerFunc({
        keyId: 'agent-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: ['file.read']
      })
      registerHandlerFunc({
        keyId: 'agent-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: ['terminal.ensureAgentSession']
      })
      registerHandlerFunc({
        keyId: 'agent-3',
        agentType: 'codex',
        sessionId: 'session-3',
        supportedMethods: ['file.write']
      })

      const listHandlerFunc = listHandler as (params: unknown) => unknown
      let allAgents = listHandlerFunc({}) as any
      expect(allAgents.agents).toHaveLength(3)

      const piAgents = listHandlerFunc({ agentType: 'pi' }) as any
      expect(piAgents.agents).toHaveLength(1)

      const fileReadAgents = listHandlerFunc({ capability: 'file.read' }) as any
      expect(fileReadAgents.agents).toHaveLength(1)

      const unregisterHandlerFunc = unregisterHandler as (params: unknown) => unknown
      unregisterHandlerFunc({ keyId: 'agent-1' })
      unregisterHandlerFunc({ keyId: 'agent-3' })

      const remaining = listHandlerFunc({}) as any
      expect(remaining.agents).toHaveLength(1)
      expect(remaining.agents[0].keyId).toBe('agent-2')
    })
  })
})
