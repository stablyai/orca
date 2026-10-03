// The status feed's subscribers: each gets every event, and one whose transport throws is dropped.

import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

export class StructuredAgentSessionStatusSubscribers {
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()

  add(subscriber: StructuredAgentSessionStatusSubscriber, first: AgentSessionStatusEvent): void {
    this.subscribers.set(subscriber.id, subscriber)
    this.emit(subscriber, first)
  }

  remove(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  broadcast(event: AgentSessionStatusEvent): void {
    // A Map skips entries deleted mid-iteration, so a failing subscriber can drop itself here.
    for (const subscriber of this.subscribers.values()) {
      this.emit(subscriber, event)
    }
  }

  /** A dead transport must not poison every later publication. */
  private emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent) {
    try {
      subscriber.emit(event)
    } catch {
      this.subscribers.delete(subscriber.id)
    }
  }
}
