import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import { isStructuredAgentSessionReceiptUpdate } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-receipt-state'
import { reduceStructuredChatState } from '../transcript/persistence/mobile-native-chat-transcript-writer'

const MAX_RETAINED_SESSION_STATES = 32

export function createMobileStructuredChatStateCache() {
  const retained = new Map<string, StructuredAgentSessionState>()
  const subscriptions = new Map<string, Set<() => void>>()
  return {
    get: (key: string) => retained.get(key),
    subscribe(key: string, listener: () => void) {
      const listeners = subscriptions.get(key) ?? new Set()
      subscriptions.set(key, listeners)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          subscriptions.delete(key)
        }
      }
    },
    apply(
      key: string,
      stored: () => StructuredAgentSessionState | null | undefined,
      action: StructuredAgentSessionAction,
      receivedAt: number
    ) {
      const previous = retained.get(key) ?? stored() ?? EMPTY_STRUCTURED_AGENT_SESSION
      const next = reduceStructuredChatState(previous, action, receivedAt)
      if (next === previous) {
        return
      }
      if (!isStructuredAgentSessionReceiptUpdate(previous, next, action)) {
        retained.delete(key)
      }
      retained.set(key, next)
      if (retained.size > MAX_RETAINED_SESSION_STATES) {
        const oldest = retained.keys().next().value
        if (oldest === undefined) {
          return
        }
        retained.delete(oldest)
        subscriptions.get(oldest)?.forEach((listener) => listener())
      }
      subscriptions.get(key)?.forEach((listener) => listener())
    }
  }
}
