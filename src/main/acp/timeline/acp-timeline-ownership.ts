import { AcpItemOwnership } from './acp-item-ownership'
import { AcpToolTimeline } from './acp-tool-timeline'
import { AcpTurnMessages } from './acp-turn-messages'

export class AcpTimelineOwnership {
  private readonly items = new AcpItemOwnership()
  readonly tools: AcpToolTimeline
  readonly messages: AcpTurnMessages
  disposed = false

  constructor() {
    this.tools = new AcpToolTimeline(this.items)
    this.messages = new AcpTurnMessages(this.items)
  }

  operation(): { settled: (turn: string) => boolean; open: (turn: string) => void } {
    const settled = (turn: string): boolean => this.items.settled(turn)
    return {
      settled,
      open: (turn) => {
        if (!this.disposed && !settled(turn)) {
          this.items.open(turn)
        }
      }
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
