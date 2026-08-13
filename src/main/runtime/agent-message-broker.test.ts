/**
 * Unit tests for Agent Message Broker (P0-2)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentMessageBroker } from './agent-message-broker'
import { AgentRegistry, setGlobalAgentRegistry } from './agent-registry'
import type { AgentMessage } from '../../shared/agent-message-broker'
import { AGENT_MESSAGE_BROKER_CONFIG } from '../../shared/agent-message-broker'

describe('AgentMessageBroker', () => {
  let broker: AgentMessageBroker
  let registry: AgentRegistry

  beforeEach(() => {
    broker = new AgentMessageBroker()
    registry = new AgentRegistry({ cleanupIntervalMs: 100 })
    setGlobalAgentRegistry(registry)
  })

  afterEach(() => {
    broker.clear()
    registry.shutdown()
    setGlobalAgentRegistry(null)
  })

  function registerAgent(keyId: string): void {
    registry.register({
      keyId,
      agentType: 'pi',
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
