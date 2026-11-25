import type { AgentSessionStatusEvent } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionStatusSubscriber } from './structured-agent-session-status-feed-deps'

export class StructuredAgentSessionStatusSubscriptions {
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()

  add(subscriber: StructuredAgentSessionStatusSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber)
    return () => this.unsubscribe(subscriber.id)
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (subscriber) {
      this.subscribers.delete(id)
      try {
        subscriber.emit({ type: 'end' })
      } catch {}
    }
  }

  broadcast = (event: AgentSessionStatusEvent): void => {
    // Map iteration permits failed subscribers to remove themselves.
    for (const subscriber of this.subscribers.values()) {
      this.emit(subscriber, event)
    }
  }

  emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent): void {
    try {
      subscriber.emit(event)
    } catch {
      this.subscribers.delete(subscriber.id)
    }
  }
}
