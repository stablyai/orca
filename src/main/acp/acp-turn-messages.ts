import { BoundedMap } from '../../shared/bounded-map'
import type { SessionUpdate } from './generated/acp-protocol.generated'

type MessagePosition = { ordinal: number; channel?: string }

/** Stable turn-relative message positions. */
export class AcpTurnMessages {
  private readonly turns = new BoundedMap<string, MessagePosition>({ maxEntries: 128 })

  key(turn: string, update: SessionUpdate): string | undefined {
    const state = this.turns.get(turn) ?? { ordinal: 0 }
    this.turns.set(turn, state)
    if (
      update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk'
    ) {
      if (['tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate)) {
        state.channel = undefined
      }
      return undefined
    }
    if (update.messageId) {
      return `message:${update.messageId}`
    }
    if (state.channel !== update.sessionUpdate) {
      state.ordinal += 1
      state.channel = update.sessionUpdate
    }
    return `turn-message:${JSON.stringify([turn, state.ordinal])}`
  }

  end(turn: string): void {
    this.turns.delete(turn)
  }
}
