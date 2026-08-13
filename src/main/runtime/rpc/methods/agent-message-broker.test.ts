/**
 * Unit tests for Agent Message Broker RPC methods (P0-2, P1-1 consent gate)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AgentRegistry, setGlobalAgentRegistry } from '../../agent-registry'
import { AgentMessageBroker, setGlobalAgentMessageBroker } from '../../agent-message-broker'
import { AgentConsentStore, setGlobalAgentConsentStore } from '../../agent-consent-store'
import { AGENT_MESSAGE_BROKER_METHODS } from './agent-message-broker'

describe('Agent Message Broker RPC Methods', () => {
  let registry: AgentRegistry
  let broker: AgentMessageBroker
  let consentStore: AgentConsentStore
  let consentDir: string
  let sendHandler: unknown

  beforeEach(async () => {
    registry = new AgentRegistry({ cleanupIntervalMs: 100 })
    setGlobalAgentRegistry(registry)
    broker = new AgentMessageBroker()
    setGlobalAgentMessageBroker(broker)

    consentDir = await mkdtemp(join(tmpdir(), 'orca-agent-message-broker-rpc-test-'))
    consentStore = new AgentConsentStore(consentDir)
    setGlobalAgentConsentStore(consentStore)

    sendHandler = AGENT_MESSAGE_BROKER_METHODS.find((m) => m.name === 'agent.message.send')?.handler
  })

  afterEach(async () => {
    broker.clear()
    setGlobalAgentMessageBroker(null)
    registry.shutdown()
    setGlobalAgentRegistry(null)
    setGlobalAgentConsentStore(null)
    await rm(consentDir, { recursive: true, force: true })
  })

  describe('agent.message.send', () => {
    it('delivers a message to a registered, subscribed target via RPC', () => {
      registry.register({
        keyId: 'source-key-1',
        agentType: 'pi',
        sessionId: 'session-source-1',
        supportedMethods: []
      })
      registry.register({
        keyId: 'target-key-1',
        agentType: 'pi',
        sessionId: 'session-1',
        supportedMethods: []
      })
      consentStore.record({ sourceAgentType: 'pi', targetAgentType: 'pi', decision: 'allow' })
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

    it('returns target-not-subscribed via RPC for a registered, consented target with no listener', () => {
      registry.register({
        keyId: 'source-key-2',
        agentType: 'codex',
        sessionId: 'session-source-2',
        supportedMethods: []
      })
      registry.register({
        keyId: 'target-key-2',
        agentType: 'codex',
        sessionId: 'session-2',
        supportedMethods: []
      })
      consentStore.record({
        sourceAgentType: 'codex',
        targetAgentType: 'codex',
        decision: 'allow'
      })

      const handler = sendHandler as (params: unknown) => unknown
      const result = handler({
        sourceKeyId: 'source-key-2',
        targetKeyId: 'target-key-2',
        payload: 'x'
      }) as any

      expect(result.status).toBe('target-not-subscribed')
    })

    it('returns permission-denied via RPC when no consent decision covers the pair', () => {
      registry.register({
        keyId: 'source-key-3',
        agentType: 'codex',
        sessionId: 'session-source-3',
        supportedMethods: []
      })
      registry.register({
        keyId: 'target-key-3',
        agentType: 'prime-agent',
        sessionId: 'session-3',
        supportedMethods: []
      })
      broker.subscribe('target-key-3', () => {})
      // No consentStore.record() call — codex -> prime-agent is unresolved.

      const handler = sendHandler as (params: unknown) => unknown
      const result = handler({
        sourceKeyId: 'source-key-3',
        targetKeyId: 'target-key-3',
        payload: 'x'
      }) as any

      expect(result.status).toBe('permission-denied')
      expect(result.denial?.code).toBe('consent_unknown')
      expect(result.listenerCount).toBe(0)
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

  describe('integration: register (P0-1) -> consent (P1-1) -> subscribe -> send -> deliver', () => {
    it('round-trips a message end to end using the registry, the consent store, and the broker', () => {
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
      consentStore.record({
        sourceAgentType: 'pi',
        targetAgentType: 'prime-agent',
        decision: 'allow'
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

      // The reverse direction (prime-agent -> pi) was never granted, so the
      // reply is blocked by the consent gate before it ever reaches the
      // "is anyone subscribed" check.
      const replyAttempt = handler({
        sourceKeyId: 'agent-y',
        targetKeyId: 'agent-x',
        payload: 'ack'
      }) as any
      expect(replyAttempt.status).toBe('permission-denied')

      // Once the user grants the reverse direction too, the same reply
      // succeeds — still reporting target-not-subscribed, because agent-x
      // itself never subscribed to receive anything, exactly as before.
      consentStore.record({
        sourceAgentType: 'prime-agent',
        targetAgentType: 'pi',
        decision: 'allow'
      })
      const replyResult = handler({
        sourceKeyId: 'agent-y',
        targetKeyId: 'agent-x',
        payload: 'ack'
      }) as any
      expect(replyResult.status).toBe('target-not-subscribed')
    })
  })
})
