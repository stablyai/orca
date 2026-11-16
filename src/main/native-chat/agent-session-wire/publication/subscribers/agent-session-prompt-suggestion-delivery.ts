import type {
  AgentSessionPromptSuggestion,
  AgentSessionSubscribeEvent
} from '../../../../../shared/agent-session/agent-session-wire'
import type { Subscriber } from './agent-session-subscribe-input'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { rememberLatestPerSession } from './structured-agent-session-activity-retention'

type PromptSuggestionDeliveryPort = {
  subscribers: (sessionId: string) => readonly Subscriber[]
  send: (subscriber: Subscriber, event: () => AgentSessionSubscribeEvent) => void
  now: () => number
  /** The session gained its first, or lost its last, subscriber that shows suggestions. */
  onInterestChanged: (sessionId: string, wanted: boolean) => void
}

/** Each session's latest suggestion, sent only to subscribers that show suggestions. */
export class AgentSessionPromptSuggestionDelivery {
  private readonly bySession = new Map<string, AgentSessionPromptSuggestion>()
  private readonly wanted = new Set<string>()

  constructor(private readonly port: PromptSuggestionDeliveryPort) {}

  publish(sessionId: string, suggestion: AgentSessionPromptSuggestion | null): void {
    // A clear always goes out: a reader may hold one this map already evicted.
    if (suggestion && this.bySession.get(sessionId)?.id === suggestion.id) {
      return
    }
    rememberLatestPerSession(this.bySession, sessionId, suggestion)
    for (const subscriber of this.port.subscribers(sessionId)) {
      this.send(subscriber, suggestion)
    }
  }

  /** Restates the retained value after the opening frames; a resumed reader may hold a stale one. */
  opened(subscriber: Subscriber): void {
    this.send(subscriber, this.bySession.get(subscriber.sessionId) ?? null)
    this.reconcile(subscriber.sessionId)
  }

  /** Recounted from the live set, so a subscriber replaced under the same id cannot leave it stale. */
  reconcile(sessionId: string): void {
    const wanted = this.port
      .subscribers(sessionId)
      .some((subscriber) => subscriber.showsPromptSuggestions)
    if (wanted === this.wanted.has(sessionId)) {
      return
    }
    if (wanted) {
      this.wanted.add(sessionId)
    } else {
      this.wanted.delete(sessionId)
    }
    this.port.onInterestChanged(sessionId, wanted)
  }

  private send(subscriber: Subscriber, suggestion: AgentSessionPromptSuggestion | null): void {
    if (!subscriber.showsPromptSuggestions) {
      return
    }
    const hostNow = this.port.now()
    this.port.send(subscriber, () => ({
      type: 'batch',
      sessionId: subscriber.sessionId,
      batch: emptyAgentSessionBatch(subscriber.cursor),
      fence: subscriber.fence,
      hostNow,
      promptSuggestion: suggestion
    }))
  }
}
