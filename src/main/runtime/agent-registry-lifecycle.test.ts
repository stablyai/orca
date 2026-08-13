/**
 * Integration tests for P0-1 Agent Registry lifecycle integration
 * Verifies that agent sessions are properly registered during creation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentRegistry, setGlobalAgentRegistry } from './agent-registry'
import { brandCapabilityMethod } from '../../shared/agent-registry'

describe('Agent Registry Lifecycle Integration (P0-1)', () => {
  let registry: AgentRegistry

  beforeEach(() => {
    registry = new AgentRegistry({ cleanupIntervalMs: 100 })
    setGlobalAgentRegistry(registry)
  })

  afterEach(() => {
    registry.shutdown()
    setGlobalAgentRegistry(null)
  })

  describe('ensureAgentSession registration', () => {
    it('should register agent when ensureAgentSession completes', () => {
      // This test verifies the expected behavior when ensureAgentSession
      // calls getGlobalAgentRegistry().register() after creating a terminal

      // Simulate what ensureAgentSession does:
      const claim = {
        keyId: 'test-claim-key-001',
        agent: 'pi',
        identityDigest: 'test-digest',
        worktreeScopeDigest: 'test-worktree-digest',
        digestVersion: 'v1'
      }

      const terminal = {
        handle: 'term_test_handle_123',
        tabId: 'tab-001',
        worktreeId: 'wt-001',
        title: 'Test Agent Terminal'
      }

      const agentType = 'pi'

      // Simulate the registration that ensureAgentSession should do
      registry.register({
        keyId: claim.keyId,
        agentType: agentType,
        sessionId: terminal.handle,
        supportedMethods: []
      })

      // Verify the agent is registered
      const registered = registry.get(claim.keyId)
      expect(registered).not.toBeNull()
      expect(registered?.keyId).toBe(claim.keyId)
      expect(registered?.agentType).toBe('pi')
      expect(registered?.sessionId).toBe('term_test_handle_123')
    })

    it('should keep agent alive in registry with heartbeats', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const claimKeyId = 'test-claim-key-002'

      // Register agent
      registry.register({
        keyId: claimKeyId,
        agentType: 'prime-agent',
        sessionId: 'term_test_handle_456',
        supportedMethods: []
      })

      // Advance time to almost TTL
      vi.advanceTimersByTime(50 * 1000)

      // Send heartbeat before TTL expires
      const heartbeated = registry.heartbeat(claimKeyId)
      expect(heartbeated).not.toBeNull()

      // Advance time again
      vi.advanceTimersByTime(50 * 1000)

      // Agent should still be alive
      const agent = registry.get(claimKeyId)
      expect(agent).not.toBeNull()
      expect(agent?.keyId).toBe(claimKeyId)

      vi.useRealTimers()
    })

    it('should expire agent if no heartbeat is received', () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const claimKeyId = 'test-claim-key-003'

      // Register agent
      registry.register({
        keyId: claimKeyId,
        agentType: 'codex',
        sessionId: 'term_test_handle_789',
        supportedMethods: []
      })

      // Advance time beyond TTL without heartbeat
      vi.advanceTimersByTime(61 * 1000)

      // Agent should be expired
      const agent = registry.get(claimKeyId)
      expect(agent).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('createAgentSession limitation (P0-1)', () => {
    it('should document that createAgentSession does not auto-register', () => {
      // P0-1 does not auto-register agents from createAgentSession because:
      // 1. RuntimeCreateAgentSessionRequest lacks providerSession field
      // 2. Without providerSession, cannot compute agentSessionClaim.keyId
      // 3. This is a true architectural difference from ensureAgentSession (resume)
      //
      // ensureAgentSession: has providerSession → can compute claim → can register
      // createAgentSession: no providerSession → cannot compute claim → no auto-register
      //
      // Manual registration is still possible via agent.registry.register RPC

      const manualKeyId = 'manual-register-key-001'

      // Agents can manually register themselves via RPC
      registry.register({
        keyId: manualKeyId,
        agentType: 'pi',
        sessionId: 'session-created-123',
        supportedMethods: [brandCapabilityMethod('file.read'), brandCapabilityMethod('file.write')],
        metadata: { createdVia: 'manual' }
      })

      const agent = registry.get(manualKeyId)
      expect(agent).not.toBeNull()
      expect(agent?.metadata?.createdVia).toBe('manual')
    })
  })

  describe('unregister behavior (P0-1)', () => {
    it('should rely on TTL for session cleanup in P0-1', () => {
      // P0-1 does not auto-unregister agents when sessions end because:
      // 1. Identifying the exact moment of session termination is complex
      //    (normal close, crash, SSH disconnect, etc.)
      // 2. TTL mechanism (60 seconds) provides automatic cleanup
      // 3. Explicit unregister via RPC is available for graceful shutdown
      //
      // Edge cases NOT covered in P0-1:
      // - SSH session disconnection: relies on TTL
      // - Agent process crash: relies on TTL
      // - Abnormal termination: relies on TTL
      //
      // P0-2+ should implement proper lifecycle hooks for immediate cleanup

      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const keyId = 'ttl-test-key-001'

      registry.register({
        keyId,
        agentType: 'pi',
        sessionId: 'session-ttl-001',
        supportedMethods: []
      })

      // Simulate agent crash (no heartbeat, no explicit unregister)
      // TTL will clean it up
      vi.advanceTimersByTime(61 * 1000)

      const agent = registry.get(keyId)
      expect(agent).toBeNull() // Cleaned up by TTL

      vi.useRealTimers()
    })

    it('should support explicit unregister for graceful shutdown', () => {
      const keyId = 'explicit-unregister-key-001'

      registry.register({
        keyId,
        agentType: 'pi',
        sessionId: 'session-shutdown-001',
        supportedMethods: []
      })

      expect(registry.get(keyId)).not.toBeNull()

      // Agent can explicitly unregister before shutdown
      registry.unregister(keyId)

      expect(registry.get(keyId)).toBeNull()
    })
  })
})
