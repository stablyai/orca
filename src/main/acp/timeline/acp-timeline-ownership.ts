import { AcpItemOwnership } from './acp-item-ownership'
import type { AcpOwnershipReader } from '../journal/acp-ownership-reader'
import { AcpToolTimeline } from './acp-tool-timeline'
import { AcpTurnMessages } from './acp-turn-messages'

export class AcpTimelineOwnership {
  private readonly items = new AcpItemOwnership()
  readonly tools: AcpToolTimeline
  readonly messages: AcpTurnMessages
  disposed = false

  constructor(private readonly read?: AcpOwnershipReader) {
    this.tools = new AcpToolTimeline(this.items, read)
    this.messages = new AcpTurnMessages(this.items, read)
  }

  operation(): { settled: (turn: string) => boolean; open: (turn: string) => void } {
    const durable = new Map<string, boolean>()
    const settled = (turn: string): boolean => {
      if (this.items.settled(turn)) {
        return true
      }
      const known = durable.get(turn)
      if (known !== undefined) {
        return known
      }
      const value = this.read?.settled(turn) === true
      durable.set(turn, value)
      return value
    }
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
