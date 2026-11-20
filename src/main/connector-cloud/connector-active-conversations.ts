// Linked conversations whose turn or workers still run, from the watch's events: their results still
// go to the cloud, so a client no longer needed waits for them before it stops.
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'

export class ConnectorActiveConversations {
  private readonly turns = new Set<string>()
  private readonly workers = new Set<string>()

  get idle(): boolean {
    return this.turns.size === 0 && this.workers.size === 0
  }

  observe(event: ConversationSnapshot | ConversationEvent): void {
    switch (event.kind) {
      case 'snapshot':
        this.turns.clear()
        this.workers.clear()
        for (const conversation of event.conversations) {
          if (conversation.working) {
            this.turns.add(conversation.paneKey)
          }
          if (conversation.workersRunning) {
            this.workers.add(conversation.paneKey)
          }
        }
        return
      case 'turn-started':
        this.turns.add(event.paneKey)
        return
      case 'turn-ended':
        this.turns.delete(event.paneKey)
        return
      case 'workers':
        if (event.running) {
          this.workers.add(event.paneKey)
        } else {
          this.workers.delete(event.paneKey)
        }
        break
      case 'unlinked':
        this.turns.delete(event.paneKey)
        this.workers.delete(event.paneKey)
        break
      // A link starts no work; a prompt and what a turn is doing arrive inside a turn turn-started
      // already counts.
      case 'linked':
      case 'prompt':
      case 'activity':
        break
    }
  }
}
