/**
 * Unit tests for Agent Message Broker RPC methods (P0-2)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentRegistry, setGlobalAgentRegistry } from '../../agent-registry'
import { AgentMessageBroker, setGlobalAgentMessageBroker } from '../../agent-message-broker'
import { AGENT_MESSAGE_BROKER_METHODS } from './agent-message-broker'

describe('Agent Message Broker RPC Methods', () => {
  let registry: AgentRegistry
  let broker: AgentMessageBroker
  let sendHandler: unknown

  beforeEach(() => {
    registry = new AgentRegistry({ cleanupIntervalMs: 100 })
    setGlobalAgentRegistry(registry)
    broker = new AgentMessageBroker()
    setGlobalAgentMessageBroker(broker)

    sendHandler = AGENT_MESSAGE_BROKER_METHODS.find((m) => m.name === 'agent.message.send')?.handler
  })

  afterEach(() => {
    broker.clear()
    setGlobalAgentMessageBroker(null)
    registry.shutdown()
    setGlobalAgentRegistry(null)
  })

  describe('agent.message.send', () => {
    it('delivers a message to a registered, subscribed target via RPC', () => {
      registry.register({
        keyId: 'target-key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })
      const received: unknown[] = []
      broker.subscribe('target-key-1', (message) => received.push(message))

      const handler = sendHandler as (params: unknown) => unknown
      const result = handler({
        sourceKeyId: 'source-key-1',
        targetKeyId: 'target-key-1',
        payload: { text: 'hello' }
      }) as any

      expect(result.status).toBe('delivered')
      expect(result.listenerCount).toBe(1)
      expect(result.message.sourceKeyId).toBe('source-key-1')
      expect(result.message.targetKeyId).toBe('target-key-1')
      expect(result.message.payload).toEqual({ text: 'hello' })
      expect(received).toHaveLength(1)
    })

    it('returns target-not-found via RPC for an unregistered target', () => {
      const handler = sendHandler as (params: unknown) => unknown
      const result = handler({
        sourceKeyId: 'source-key-1',
        targetKeyId: 'no-such-agent',
        payload: 'x'
      }) as any

      expect(result.status).toBe('target-not-found')
      expect(result.listenerCount).toBe(0)
    })

    it('returns target-not-subscribed via RPC for a registered target with no listener', () => {
      registry.register({
        keyId: 'target-key-2',
        agentType: 'codex',
        sessionId: 'session-2',
        supportedMethods: []
      })

      const handler = sendHandler as (params: unknown) => unknown
      const result = handler({
        sourceKeyId: 'source-key-1',
        targetKeyId: 'target-key-2',
        payload: 'x'
      }) as any

      expect(result.status).toBe('target-not-subscribed')
    })

    it('never throws for a routing miss — the outcome is a typed status, not an RPC error', () => {
      const handler = sendHandler as (params: unknown) => unknown
      expect(() =>
        handler({
          sourceKeyId: 'source-key-1',
          targetKeyId: 'definitely-not-registered',
          payload: null
        })
      ).not.toThrow()
    })
  })

  describe('integration: register (P0-1) -> subscribe -> send -> deliver', () => {
    it('round-trips a message end to end using both registry and broker', () => {
      registry.register({
        keyId: 'agent-x',
        agentType: 'pi',
        sessionId: 'session-x',
        supportedMethods: []
      })
      registry.register({
        keyId: 'agent-y',
        agentType: 'prime-agent',
        sessionId: 'session-y',
        supportedMethods: []
      })

      const inboxY: unknown[] = []
      broker.subscribe('agent-y', (message) => inboxY.push(message))

      const handler = sendHandler as (params: unknown) => unknown
      const result = handler({
        sourceKeyId: 'agent-x',
        targetKeyId: 'agent-y',
        payload: { task: 'review PR #1' }
      }) as any

      expect(result.status).toBe('delivered')
      expect(inboxY).toHaveLength(1)
      expect((inboxY[0] as any).payload).toEqual({ task: 'review PR #1' })

      // agent-x never subscribed, so a reply attempt reports target-not-subscribed,
      // not target-not-found — it's registered, just not listening yet.
      const replyResult = handler({
        sourceKeyId: 'agent-y',
        targetKeyId: 'agent-x',
        payload: 'ack'
      }) as any
      expect(replyResult.status).toBe('target-not-subscribed')
    })
  })
})
