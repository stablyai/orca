import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import { isStructuredAgentSessionReceiptUpdate } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-receipt-state'
import { reduceStructuredChatState } from '../transcript/persistence/mobile-native-chat-transcript-writer'

const MAX_RETAINED_SESSION_STATES = 32

type StateEntry = {
  current: StructuredAgentSessionState
  published: StructuredAgentSessionState
}
type Subscriptions = Map<string, Set<() => void>>

function subscribe(subscriptions: Subscriptions, key: string, listener: () => void) {
  const listeners = subscriptions.get(key) ?? new Set()
  subscriptions.set(key, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      subscriptions.delete(key)
    }
  }
}

export function createMobileStructuredChatStateCache() {
  const retained = new Map<string, StateEntry>()
  const sessions: Subscriptions = new Map()
  const delivery: Subscriptions = new Map()
  return {
    get: (key: string) => retained.get(key)?.current,
    getSnapshot: (key: string) => retained.get(key)?.published,
    currentForSnapshot(key: string | null, published: StructuredAgentSessionState) {
      const entry = key ? retained.get(key) : undefined
      return entry?.published === published ? entry.current : published
    },
    subscribe: (key: string, listener: () => void) => subscribe(sessions, key, listener),
    subscribeDelivery: (key: string, listener: () => void) => subscribe(delivery, key, listener),
    apply(
      key: string,
      stored: () => StructuredAgentSessionState | null | undefined,
      action: StructuredAgentSessionAction,
      receivedAt: number
    ) {
      const entry = retained.get(key)
      const previous = entry?.current ?? stored() ?? EMPTY_STRUCTURED_AGENT_SESSION
      const next = reduceStructuredChatState(previous, action, receivedAt)
      if (next === previous) {
        return
      }
      if (entry && isStructuredAgentSessionReceiptUpdate(previous, next, action)) {
        entry.current = next
        if (previous.writtenAtById !== next.writtenAtById) {
          delivery.get(key)?.forEach((listener) => listener())
        }
        return next
      }
      retained.delete(key)
      retained.set(key, { current: next, published: next })
      if (retained.size > MAX_RETAINED_SESSION_STATES) {
        const oldest = retained.keys().next().value
        if (oldest === undefined) {
          return
        }
        retained.delete(oldest)
        sessions.get(oldest)?.forEach((listener) => listener())
        delivery.get(oldest)?.forEach((listener) => listener())
      }
      sessions.get(key)?.forEach((listener) => listener())
      return next
    }
  }
}
