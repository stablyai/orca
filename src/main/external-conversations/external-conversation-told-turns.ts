// Chats whose running turn the conversation was told of: a delivery's, a report's, or a wake-up for
// runs launched for it. A wake-up stops being told once it is no longer only those runs' (a message
// read into it, another run finished into it), so its live activity stops reaching the conversation.
import type { ChatTurnsDeps } from './external-conversation-chat-turns-deps'

export class ToldTurns {
  private readonly told = new Set<string>()
  private readonly asWake = new Set<string>()

  constructor(private readonly deps: Pick<ChatTurnsDeps, 'linkedFor' | 'runningTurnWoken'>) {}

  add(paneKey: string, asWake = false): void {
    this.told.add(paneKey)
    if (asWake) {
      this.asWake.add(paneKey)
    }
  }

  /** Told, and (a wake-up) still the conversation's. */
  has(paneKey: string): boolean {
    return this.told.has(paneKey) && !(this.asWake.has(paneKey) && !this.stillWoken(paneKey))
  }

  private stillWoken(paneKey: string): boolean {
    const sessionId = this.deps.linkedFor(paneKey)?.link.sessionId
    return !!sessionId && this.deps.runningTurnWoken(sessionId)
  }

  /** The turn ended: whether it was told at all. */
  delete(paneKey: string): boolean {
    this.asWake.delete(paneKey)
    return this.told.delete(paneKey)
  }

  clear(): void {
    this.told.clear()
    this.asWake.clear()
  }
}
