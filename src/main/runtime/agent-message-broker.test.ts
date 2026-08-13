/**
 * Unit tests for Agent Message Broker (P0-2, P1-1 consent gate)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentMessageBroker } from './agent-message-broker'
import { AgentRegistry, setGlobalAgentRegistry } from './agent-registry'
import { AgentConsentStore, setGlobalAgentConsentStore } from './agent-consent-store'
import type { AgentMessage } from '../../shared/agent-message-broker'
import { AGENT_MESSAGE_BROKER_CONFIG } from '../../shared/agent-message-broker'

describe('AgentMessageBroker', () => {
  let broker: AgentMessageBroker
  let registry: AgentRegistry
  let consentStore: AgentConsentStore
  let consentDir: string

  beforeEach(async () => {
    broker = new AgentMessageBroker()
    registry = new AgentRegistry({ cleanupIntervalMs: 100 })
    setGlobalAgentRegistry(registry)

    consentDir = await mkdtemp(join(tmpdir(), 'orca-agent-message-broker-test-'))
    consentStore = new AgentConsentStore(consentDir)
    setGlobalAgentConsentStore(consentStore)

    // Why: every test in this file (other than the dedicated "P1-1 consent
    // gate" describe block below) predates the consent gate and sends from
    // 'source-1' to a 'pi'-type target. Registering 'source-1' as 'pi' and
    // blanket-granting pi -> pi keeps all of that P0-2 routing-outcome
    // coverage exercising exactly what it exercised before, without
    // threading gate setup through every single case.
    registry.register({
      keyId: 'source-1',
      agentType: 'pi',
      sessionId: 'session-source-1',
      supportedMethods: []
    })
    consentStore.record({ sourceAgentType: 'pi', targetAgentType: 'pi', decision: 'allow' })
  })

  afterEach(async () => {
    broker.clear()
    registry.shutdown()
    setGlobalAgentRegistry(null)
    setGlobalAgentConsentStore(null)
    await rm(consentDir, { recursive: true, force: true })
  })

  function registerAgent(keyId: string, agentType = 'pi'): void {
    registry.register({
      keyId,
      agentType,
      sessionId: `session-${keyId}`,
      supportedMethods: []
    })
  }

  describe('send: routing outcomes', () => {
    it('delivers to a registered target with an active subscriber', () => {
      registerAgent('target-1')
      const received: AgentMessage[] = []
      broker.subscribe('target-1', (message) => received.push(message))

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-1',
        payload: { hello: 'world' }
      })

      expect(result.status).toBe('delivered')
      expect(result.listenerCount).toBe(1)
      expect(received).toHaveLength(1)
      expect(received[0].sourceKeyId).toBe('source-1')
      expect(received[0].targetKeyId).toBe('target-1')
      expect(received[0].payload).toEqual({ hello: 'world' })
      expect(received[0].messageId).toBeTruthy()
      expect(received[0].timestamp).toBeGreaterThan(0)
    })

    it('reports target-not-found for a keyId that was never registered', () => {
      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'never-registered',
        payload: 'hi'
      })

      expect(result.status).toBe('target-not-found')
      expect(result.listenerCount).toBe(0)
      // The message is still fully formed even though delivery failed.
      expect(result.message.targetKeyId).toBe('never-registered')
      expect(result.message.messageId).toBeTruthy()
    })

    it('reports target-not-found for a keyId that was registered then unregistered', () => {
      registerAgent('target-2')
      broker.subscribe('target-2', () => {})
      registry.unregister('target-2')

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-2',
        payload: 'hi'
      })

      expect(result.status).toBe('target-not-found')
    })

    it('reports target-not-subscribed for a registered target with no listener', () => {
      registerAgent('target-3')

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-3',
        payload: 'hi'
      })

      expect(result.status).toBe('target-not-subscribed')
      expect(result.listenerCount).toBe(0)
    })

    it('reports target-not-subscribed after the sole subscriber unsubscribes', () => {
      registerAgent('target-4')
      const unsubscribe = broker.subscribe('target-4', () => {})
      unsubscribe()

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-4',
        payload: 'hi'
      })

      expect(result.status).toBe('target-not-subscribed')
    })

    it('does not deliver to a subscriber whose keyId is not registered, even though someone is listening', () => {
      // No registerAgent() call for 'ghost' — simulates a listener left behind
      // after its owner's registry entry already expired/unregistered.
      const received: AgentMessage[] = []
      broker.subscribe('ghost', (message) => received.push(message))

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'ghost',
        payload: 'hi'
      })

      expect(result.status).toBe('target-not-found')
      expect(received).toHaveLength(0)
    })
  })

  describe('P1-1 consent gate', () => {
    it('reports permission-denied when the source agentType has no recorded decision for the target agentType', () => {
      registerAgent('codex-source', 'codex')
      registerAgent('gate-target-1', 'prime-agent')
      broker.subscribe('gate-target-1', () => {})
      // Deliberately no consentStore.record() call for codex -> prime-agent.

      const result = broker.send({
        sourceKeyId: 'codex-source',
        targetKeyId: 'gate-target-1',
        payload: 'hi'
      })

      expect(result.status).toBe('permission-denied')
      expect(result.listenerCount).toBe(0)
      expect(result.denial?.code).toBe('consent_unknown')
    })

    it('reports permission-denied when the source agentType was explicitly denied for the target agentType', () => {
      registerAgent('codex-source-2', 'codex')
      registerAgent('gate-target-2', 'prime-agent')
      broker.subscribe('gate-target-2', () => {})
      consentStore.record({
        sourceAgentType: 'codex',
        targetAgentType: 'prime-agent',
        decision: 'deny'
      })

      const result = broker.send({
        sourceKeyId: 'codex-source-2',
        targetKeyId: 'gate-target-2',
        payload: 'hi'
      })

      expect(result.status).toBe('permission-denied')
      expect(result.denial?.code).toBe('consent_denied')
    })

    it('does not invoke any subscriber when the send is permission-denied', () => {
      registerAgent('codex-source-3', 'codex')
      registerAgent('gate-target-3', 'prime-agent')
      const received: AgentMessage[] = []
      broker.subscribe('gate-target-3', (message) => received.push(message))
      // No consent recorded -> unknown -> denied.

      const result = broker.send({
        sourceKeyId: 'codex-source-3',
        targetKeyId: 'gate-target-3',
        payload: 'hi'
      })

      expect(result.status).toBe('permission-denied')
      expect(received).toHaveLength(0)
    })

    it('delivers once the exact (sourceAgentType, targetAgentType) pair is granted', () => {
      registerAgent('codex-source-4', 'codex')
      registerAgent('gate-target-4', 'prime-agent')
      const received: AgentMessage[] = []
      broker.subscribe('gate-target-4', (message) => received.push(message))
      consentStore.record({
        sourceAgentType: 'codex',
        targetAgentType: 'prime-agent',
        decision: 'allow'
      })

      const result = broker.send({
        sourceKeyId: 'codex-source-4',
        targetKeyId: 'gate-target-4',
        payload: 'hi'
      })

      expect(result.status).toBe('delivered')
      expect(received).toHaveLength(1)
    })

    it('a grant for (typeA -> typeB) does not also grant the reverse (typeB -> typeA)', () => {
      registerAgent('codex-source-5', 'codex')
      registerAgent('prime-target-5', 'prime-agent')
      broker.subscribe('codex-source-5', () => {})
      broker.subscribe('prime-target-5', () => {})
      consentStore.record({
        sourceAgentType: 'codex',
        targetAgentType: 'prime-agent',
        decision: 'allow'
      })

      const forward = broker.send({
        sourceKeyId: 'codex-source-5',
        targetKeyId: 'prime-target-5',
        payload: 'forward'
      })
      expect(forward.status).toBe('delivered')

      const reverse = broker.send({
        sourceKeyId: 'prime-target-5',
        targetKeyId: 'codex-source-5',
        payload: 'reverse'
      })
      expect(reverse.status).toBe('permission-denied')
    })

    it('reports permission-denied (not target-not-found) for an unregistered source and a registered, consented-open target', () => {
      registerAgent('gate-target-6', 'prime-agent')
      broker.subscribe('gate-target-6', () => {})
      // Even a blanket grant can't help — there is no resolvable source
      // agentType, so the gate sees 'unknown' regardless of what's recorded.
      consentStore.record({
        sourceAgentType: 'codex',
        targetAgentType: 'prime-agent',
        decision: 'allow'
      })

      const result = broker.send({
        sourceKeyId: 'never-registered-source',
        targetKeyId: 'gate-target-6',
        payload: 'hi'
      })

      expect(result.status).toBe('permission-denied')
      expect(result.denial?.code).toBe('consent_unknown')
    })

    it('target-not-found still takes priority over an unresolved consent decision', () => {
      // Confirms ordering: a target that plain does not exist must never be
      // reported as permission-denied — that would wrongly imply the target
      // exists and consent is the only problem.
      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'no-such-target-at-all',
        payload: 'hi'
      })

      expect(result.status).toBe('target-not-found')
    })
  })

  describe('subscribe / unsubscribe', () => {
    it('fans out one message to multiple subscribers of the same keyId', () => {
      registerAgent('target-5')
      const receivedA: AgentMessage[] = []
      const receivedB: AgentMessage[] = []
      broker.subscribe('target-5', (m) => receivedA.push(m))
      broker.subscribe('target-5', (m) => receivedB.push(m))

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-5',
        payload: 'broadcast'
      })

      expect(result.status).toBe('delivered')
      expect(result.listenerCount).toBe(2)
      expect(receivedA).toHaveLength(1)
      expect(receivedB).toHaveLength(1)
      expect(receivedA[0].messageId).toBe(receivedB[0].messageId)
    })

    it('does not deliver to a listener registered under a different keyId', () => {
      registerAgent('target-a')
      registerAgent('target-b')
      const receivedA: AgentMessage[] = []
      const receivedB: AgentMessage[] = []
      broker.subscribe('target-a', (m) => receivedA.push(m))
      broker.subscribe('target-b', (m) => receivedB.push(m))

      broker.send({ sourceKeyId: 'source-1', targetKeyId: 'target-a', payload: 'for-a' })

      expect(receivedA).toHaveLength(1)
      expect(receivedB).toHaveLength(0)
    })

    it('unsubscribe is idempotent', () => {
      registerAgent('target-6')
      const unsubscribe = broker.subscribe('target-6', () => {})
      expect(broker.listenerCount('target-6')).toBe(1)
      unsubscribe()
      expect(broker.listenerCount('target-6')).toBe(0)
      // Calling again must not throw and must not affect a fresh subscriber
      // registered under the same keyId afterwards.
      expect(() => unsubscribe()).not.toThrow()
      broker.subscribe('target-6', () => {})
      unsubscribe()
      expect(broker.listenerCount('target-6')).toBe(1)
    })

    it('a listener that unsubscribes itself during delivery does not break delivery to the remaining listener', () => {
      registerAgent('target-7')
      const receivedB: AgentMessage[] = []
      let unsubscribeA: () => void = () => {}
      unsubscribeA = broker.subscribe('target-7', () => {
        unsubscribeA()
      })
      broker.subscribe('target-7', (m) => receivedB.push(m))

      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-7',
        payload: 'x'
      })

      expect(result.status).toBe('delivered')
      expect(result.listenerCount).toBe(2)
      expect(receivedB).toHaveLength(1)
      expect(broker.listenerCount('target-7')).toBe(1)
    })

    it('enforces MAX_LISTENERS_PER_KEY capacity', () => {
      registerAgent('target-8')
      for (let i = 0; i < AGENT_MESSAGE_BROKER_CONFIG.MAX_LISTENERS_PER_KEY; i++) {
        broker.subscribe('target-8', () => {})
      }
      expect(() => broker.subscribe('target-8', () => {})).toThrow(
        'agent_message_broker_listener_capacity'
      )
    })
  })

  describe('ordering', () => {
    it('delivers multiple messages to the same target in send order (FIFO)', () => {
      registerAgent('target-9')
      const received: AgentMessage[] = []
      broker.subscribe('target-9', (m) => received.push(m))

      broker.send({ sourceKeyId: 'source-1', targetKeyId: 'target-9', payload: 1 })
      broker.send({ sourceKeyId: 'source-1', targetKeyId: 'target-9', payload: 2 })
      broker.send({ sourceKeyId: 'source-1', targetKeyId: 'target-9', payload: 3 })

      expect(received.map((m) => m.payload)).toEqual([1, 2, 3])
    })

    it('delivers to subscribers in subscription order for a single send', () => {
      registerAgent('target-10')
      const order: string[] = []
      broker.subscribe('target-10', () => order.push('first'))
      broker.subscribe('target-10', () => order.push('second'))
      broker.subscribe('target-10', () => order.push('third'))

      broker.send({ sourceKeyId: 'source-1', targetKeyId: 'target-10', payload: null })

      expect(order).toEqual(['first', 'second', 'third'])
    })
  })

  describe('clear', () => {
    it('removes all subscriptions', () => {
      registerAgent('target-11')
      broker.subscribe('target-11', () => {})
      expect(broker.listenerCount('target-11')).toBe(1)

      broker.clear()

      expect(broker.listenerCount('target-11')).toBe(0)
      const result = broker.send({
        sourceKeyId: 'source-1',
        targetKeyId: 'target-11',
        payload: 'x'
      })
      expect(result.status).toBe('target-not-subscribed')
    })
  })
})
