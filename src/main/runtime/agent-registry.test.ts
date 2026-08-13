/**
 * Unit tests for Agent Registry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentRegistry } from './agent-registry'
import { AGENT_REGISTRY_CONFIG, brandCapabilityMethod } from '../../shared/agent-registry'

describe('AgentRegistry', () => {
  let registry: AgentRegistry

  beforeEach(() => {
    registry = new AgentRegistry({ cleanupIntervalMs: 100 }) // Fast cleanup for testing
  })

  afterEach(() => {
    registry.shutdown()
  })

  describe('register', () => {
    it('should register an agent with basic info', () => {
      const agent = registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: [brandCapabilityMethod('terminal.ensureAgentSession')]
      })

      expect(agent.keyId).toBe('test-key-1')
      expect(agent.agentType).toBe('pi')
      expect(agent.sessionId).toBe('session-123')
      expect(agent.capabilities.supportedMethods).toHaveLength(1)
      expect(agent.capabilities.capabilityDigest).toBeTruthy()
    })

    it('should update existing agent with same keyId', () => {
      const agent1 = registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: [brandCapabilityMethod('file.read')]
      })

      const firstDeclaredAt = agent1.capabilities.declaredAt
      expect(agent1.sessionId).toBe('session-1')

      // Small delay to ensure timestamp differs
      vi.useFakeTimers()
      vi.advanceTimersByTime(10)
      vi.useRealTimers()

      const agent2 = registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-2',
        supportedMethods: [brandCapabilityMethod('file.read'), brandCapabilityMethod('file.write')]
      })

      expect(agent2.sessionId).toBe('session-2')
      expect(agent2.capabilities.supportedMethods).toHaveLength(2)
      expect(agent2.capabilities.declaredAt).toBeGreaterThanOrEqual(firstDeclaredAt)
    })

    it('should include metadata if provided', () => {
      const metadata = { worktreeId: 'wt-123', platform: 'darwin' }
      const agent = registry.register({
        keyId: 'test-key-1',
        agentType: 'prime-agent',
        sessionId: 'session-123',
        supportedMethods: [],
        metadata
      })

      expect(agent.metadata).toEqual(metadata)
    })
  })

  describe('get', () => {
    it('should retrieve a registered agent by keyId', () => {
      registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      const agent = registry.get('test-key-1')
      expect(agent).not.toBeNull()
      expect(agent?.keyId).toBe('test-key-1')
    })

    it('should return null for non-existent keyId', () => {
      const agent = registry.get('non-existent')
      expect(agent).toBeNull()
    })

    it('should return null for expired agent', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      // Advance time beyond TTL
      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS + 1000)

      const agent = registry.get('test-key-1')
      expect(agent).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('unregister', () => {
    it('should remove an agent from the registry', () => {
      registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      expect(registry.get('test-key-1')).not.toBeNull()

      registry.unregister('test-key-1')
      expect(registry.get('test-key-1')).toBeNull()
    })

    it('should handle unregistering non-existent agents gracefully', () => {
      expect(() => registry.unregister('non-existent')).not.toThrow()
    })
  })

  describe('list', () => {
    it('should list all registered agents', () => {
      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })
      registry.register({
        keyId: 'key-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: []
      })

      const result = registry.list()
      expect(result.agents).toHaveLength(2)
      expect(result.totalCount).toBe(2)
    })

    it('should filter by agentType', () => {
      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })
      registry.register({
        keyId: 'key-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: []
      })

      const result = registry.list({ agentType: 'pi' })
      expect(result.agents).toHaveLength(1)
      expect(result.agents[0].agentType).toBe('pi')
    })

    it('should filter by capability', () => {
      const readMethod = brandCapabilityMethod('file.read')
      const writeMethod = brandCapabilityMethod('file.write')

      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: [readMethod]
      })
      registry.register({
        keyId: 'key-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: [readMethod, writeMethod]
      })
      registry.register({
        keyId: 'key-3',
        agentType: 'codex',
        sessionId: 'session-3',
        supportedMethods: [writeMethod]
      })

      const result = registry.list({ capability: readMethod })
      expect(result.agents).toHaveLength(2)
      expect(result.agents.every((a) => a.capabilities.supportedMethods.includes(readMethod))).toBe(
        true
      )
    })

    it('should return empty array when no agents match filter', () => {
      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })

      const result = registry.list({ agentType: 'non-existent-type' })
      expect(result.agents).toHaveLength(0)
      expect(result.totalCount).toBe(1) // Total count is before filtering
    })

    it('should lazily remove expired agents during list', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })
      registry.register({
        keyId: 'key-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: []
      })

      // Advance time to expire first agent
      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS + 1000)

      // Register a new agent before listing (to keep it fresh)
      registry.register({
        keyId: 'key-3',
        agentType: 'codex',
        sessionId: 'session-3',
        supportedMethods: []
      })

      const result = registry.list()
      // key-1 should be expired and removed, key-2 should be expired and removed, key-3 is fresh
      expect(result.agents).toHaveLength(1)
      expect(result.agents[0].keyId).toBe('key-3')

      vi.useRealTimers()
    })
  })

  describe('heartbeat', () => {
    it('should update lastActivityAt timestamp', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const registered = registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      const originalActivityAt = registered.lastActivityAt

      vi.advanceTimersByTime(10000)

      const heartbeaten = registry.heartbeat('test-key-1')
      expect(heartbeaten).not.toBeNull()
      expect(heartbeaten!.lastActivityAt).toBeGreaterThan(originalActivityAt)

      vi.useRealTimers()
    })

    it('should keep agent alive with heartbeat', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      // Advance time to almost TTL
      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS - 5000)

      // Send heartbeat
      registry.heartbeat('test-key-1')

      // Advance time by another period
      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS - 5000)

      // Agent should still be alive
      const agent = registry.get('test-key-1')
      expect(agent).not.toBeNull()

      vi.useRealTimers()
    })

    it('should return null for non-existent agent', () => {
      const result = registry.heartbeat('non-existent')
      expect(result).toBeNull()
    })

    it('should return null for expired agent', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      registry.register({
        keyId: 'test-key-1',
        agentType: 'pi',
        sessionId: 'session-123',
        supportedMethods: []
      })

      // Advance time beyond TTL
      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS + 1000)

      const result = registry.heartbeat('test-key-1')
      expect(result).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('TTL expiration', () => {
    it('should automatically clean up expired entries', async () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })

      vi.advanceTimersByTime(AGENT_REGISTRY_CONFIG.TTL_MS + 500)

      // Wait for cleanup interval
      vi.advanceTimersByTime(150) // Cleanup interval is 100ms in test, add buffer

      const result = registry.list()
      expect(result.agents).toHaveLength(0)

      vi.useRealTimers()
    })
  })

  describe('clear', () => {
    it('should remove all agents', () => {
      registry.register({
        keyId: 'key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })
      registry.register({
        keyId: 'key-2',
        agentType: 'prime-agent',
        sessionId: 'session-2',
        supportedMethods: []
      })

      registry.clear()

      const result = registry.list()
      expect(result.agents).toHaveLength(0)
    })
  })
})
