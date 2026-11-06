import { AcpItemOwnership } from './acp-item-ownership'
import type { AcpOwnershipReader } from './acp-ownership-reader'
import { AcpToolTimeline } from './acp-tool-timeline'
import { AcpTurnMessages } from './acp-turn-messages'

export class AcpTimelineOwnership {
  private readonly items = new AcpItemOwnership()
  readonly tools: AcpToolTimeline
  readonly messages: AcpTurnMessages
  disposed = false

  constructor(read?: AcpOwnershipReader) {
    this.tools = new AcpToolTimeline(this.items, read)
    this.messages = new AcpTurnMessages(this.items, read)
  }

  open(turn: string): void {
    if (!this.disposed && !this.messages.isSettled(turn)) {
      this.items.open(turn)
    }
  }

  end(turn: string): void {
    this.tools.end(turn)
    this.messages.end(turn)
    this.items.end(turn)
  }

  publication(): (() => void) | undefined {
    return this.items.publication()
  }

  dispose(): void {
    this.disposed = true
    this.tools.dispose()
    this.messages.dispose()
    this.items.dispose()
  }
}
