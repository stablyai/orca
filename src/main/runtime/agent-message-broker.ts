/**
 * Agent Message Broker Implementation (P0-2)
 *
 * In-memory pub/sub that routes point-to-point messages between registered
 * agent sessions, addressed by keyId. Deliberately hand-written (Map<keyId,
 * Set<listener>>) rather than EventEmitter or RxJS: this codebase has no
 * EventEmitter precedent in src/main/runtime (grepped — none), and its
 * existing in-memory routing structures (AgentRegistry, and the pre-existing
 * ClaimedAgentPtyOwnerRegistry in src/shared/claimed-agent-pty-owner.ts) are
 * both hand-written classes over plain Maps. A Set<listener> per keyId keeps
 * that same shape and needs no wildcard/eventName plumbing EventEmitter
 * would add for a single, fixed "message for this keyId" channel.
 *
 * Integrates with the P0-1 registry (src/main/runtime/agent-registry.ts):
 * every send() first confirms the target keyId is a live registered agent
 * via getGlobalAgentRegistry().get(targetKeyId). A target that is not
 * registered can never receive a message, regardless of whether something
 * happens to be subscribed under that keyId — this stops the broker from
 * being used to message a keyId that never went through the identity
 * registry at all.
 *
 * P1-1 adds a permission check between that registry lookup and delivery:
 * send() resolves the *source*'s registered agentType (also via the P0-1
 * registry — an unregistered source resolves to no agentType, which the
 * gate treats as an unresolved decision), queries the P1-1 consent store
 * (src/main/runtime/agent-consent-store.ts) for whether that agentType may
 * message the target's agentType, and runs the result through the pure gate
 * (src/shared/agent-consent-gate.ts). A denial short-circuits before the
 * subscriber map is even consulted, reported as the new 'permission-denied'
 * status rather than a thrown error — same "typed status, not an
 * exception" philosophy the target-not-found/target-not-subscribed
 * statuses already use.
 *
 * Ordering: target existence is still checked first (unchanged from P0-2) —
 * a permission decision about a target that does not exist is meaningless,
 * and target-not-found must stay a pure routing-identity signal independent
 * of consent state. The consent gate then runs before the subscriber check,
 * so a caller learns "you are not allowed to message this agent" rather
 * than the weaker, misleading "nobody happens to be listening right now"
 * for a send that would have been denied anyway.
 *
 * Scope note (mirrors P0-1's documented scope discipline): this module only
 * provides the in-process subscribe/send primitive and its RPC send surface
 * (agent.message.send in rpc/methods/agent-message-broker.ts). It does not
 * add an RPC-exposed subscribe/streaming channel — subscribing today is an
 * in-process API (broker.subscribe) for other main-process code to call
 * directly, the same way ensureAgentSession calls registry.register()
 * directly rather than through an RPC self-call. Wiring a remote/streaming
 * receive path is left for a future phase, same as P0-1 left unregister-on
 * -session-close for a future phase.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentMessage,
  AgentMessageListener,
  AgentMessageSendRequest,
  AgentMessageSendResult
} from '../../shared/agent-message-broker'
import { AGENT_MESSAGE_BROKER_CONFIG } from '../../shared/agent-message-broker'
import type { AgentConsentQueryResult } from '../../shared/agent-consent'
import { gateAgentMessageSend } from '../../shared/agent-consent-gate'
import { getGlobalAgentRegistry } from './agent-registry'
import { getGlobalAgentConsentStore } from './agent-consent-store'

/**
 * In-memory message broker for live agent sessions.
 * Thread-safety: assumes single-threaded Node.js event loop usage, same as
 * AgentRegistry.
 */
export class AgentMessageBroker {
  /**
   * Map of targetKeyId -> set of listeners currently subscribed to receive
   * messages addressed to that keyId.
   */
  private readonly subscribers = new Map<string, Set<AgentMessageListener>>()

  /**
   * Subscribe to receive messages addressed to `keyId`.
   * Returns an unsubscribe function; calling it is idempotent (safe to call
   * more than once, or after the broker already dropped the empty Set).
   */
  subscribe(keyId: string, listener: AgentMessageListener): () => void {
    let listeners = this.subscribers.get(keyId)
    if (!listeners) {
      listeners = new Set<AgentMessageListener>()
      this.subscribers.set(keyId, listeners)
    }
    if (listeners.size >= AGENT_MESSAGE_BROKER_CONFIG.MAX_LISTENERS_PER_KEY) {
      throw new Error('agent_message_broker_listener_capacity')
    }
    listeners.add(listener)

    let unsubscribed = false
    return () => {
      if (unsubscribed) {
        return
      }
      unsubscribed = true
      const current = this.subscribers.get(keyId)
      if (!current) {
        return
      }
      current.delete(listener)
      if (current.size === 0) {
        this.subscribers.delete(keyId)
      }
    }
  }

  /**
   * Number of listeners currently subscribed for `keyId`.
   */
  listenerCount(keyId: string): number {
    return this.subscribers.get(keyId)?.size ?? 0
  }

  /**
   * Send a message to `request.targetKeyId`.
   *
   * Routing order matters: the target registry check happens BEFORE the
   * consent gate, which happens BEFORE the subscription check.
   *
   * - A keyId that was never registered (or expired) always reports
   *   'target-not-found', even if something is coincidentally still
   *   subscribed under that same string (e.g. a listener that hasn't
   *   unsubscribed yet after its owner's registry entry expired).
   * - Only once the target is known to exist does the P1-1 consent gate
   *   run (see the class-level doc comment above for why source-not-found
   *   also denies rather than bypassing the gate).
   * - The subscriber check runs last, so a message the gate would have
   *   denied never reports the weaker 'target-not-subscribed'.
   */
  send(request: AgentMessageSendRequest): AgentMessageSendResult {
    const message: AgentMessage = {
      messageId: randomUUID(),
      sourceKeyId: request.sourceKeyId,
      targetKeyId: request.targetKeyId,
      payload: request.payload,
      timestamp: Date.now()
    }

    const target = getGlobalAgentRegistry().get(request.targetKeyId)
    if (!target) {
      return { status: 'target-not-found', message, listenerCount: 0 }
    }

    const source = getGlobalAgentRegistry().get(request.sourceKeyId)
    // Why: an unregistered source has no agentType a consent decision could
    // even be recorded against — treat it the same as "never decided"
    // rather than special-casing it into either an allow or a distinct
    // status. Deny-by-default applies equally to "we don't know who this
    // is" as it does to "we know who this is but no one has said yes".
    const consentDecision: AgentConsentQueryResult = source
      ? getGlobalAgentConsentStore().query(source.agentType, target.agentType)
      : 'unknown'
    const gateResult = gateAgentMessageSend(
      { decision: consentDecision },
      { targetAgentType: target.agentType }
    )
    if (!gateResult.granted) {
      return {
        status: 'permission-denied',
        message,
        listenerCount: 0,
        denial: { code: gateResult.code, error: gateResult.error }
      }
    }

    const listeners = this.subscribers.get(request.targetKeyId)
    if (!listeners || listeners.size === 0) {
      return { status: 'target-not-subscribed', message, listenerCount: 0 }
    }

    // Why: snapshot before iterating so a listener that unsubscribes itself
    // (or subscribes a new one) while being invoked can't mutate the live
    // Set out from under this iteration (classic "modify during forEach").
    const fanOutTo = [...listeners]
    for (const listener of fanOutTo) {
      listener(message)
    }

    return { status: 'delivered', message, listenerCount: fanOutTo.length }
  }

  /**
   * Clear all subscriptions. Useful for testing or clean shutdown.
   */
  clear(): void {
    this.subscribers.clear()
  }
}

/**
 * Global singleton instance of the agent message broker.
 */
let globalAgentMessageBroker: AgentMessageBroker | null = null

/**
 * Get or create the global agent message broker instance.
 */
export function getGlobalAgentMessageBroker(): AgentMessageBroker {
  if (!globalAgentMessageBroker) {
    globalAgentMessageBroker = new AgentMessageBroker()
  }
  return globalAgentMessageBroker
}

/**
 * Set the global agent message broker (mainly for testing).
 */
export function setGlobalAgentMessageBroker(broker: AgentMessageBroker | null): void {
  globalAgentMessageBroker = broker
}
