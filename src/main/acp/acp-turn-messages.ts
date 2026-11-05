import type { SessionUpdate } from './generated/acp-protocol.generated'
import type { ProviderTimelineTextChannel } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { providerTimelineKeyPart } from '../native-chat/agent-session-timeline/provider-timeline-identity'

/** One provider message may contain both reasoning and visible text. */
export function acpNamedTextKey(messageId: string, channel: ProviderTimelineTextChannel): string {
  return `message:${JSON.stringify([messageId, channel])}`
}

type MessagePosition = { ordinal: number; channel?: string }
type MessageOwner = { turn: string; settled: boolean }

export type AcpTextDrop = {
  reason: 'turn-settled' | 'stream-mismatch'
  itemId: string | undefined
  channel: ProviderTimelineTextChannel
  threadId: string | undefined
  turnId: string | undefined
  producerAgentId?: string
}

export class AcpTurnMessages {
  private readonly turns = new Map<string, MessagePosition>()
  private readonly owners = new Map<string, MessageOwner>()
  // Whitespace-only messages have no journal row to recover their settled ownership.
  private readonly settled = new Map<string, MessageOwner>()

  /** Keep trailing chunks on the provider message's original turn. */
  owner(turn: string | undefined, update: SessionUpdate): { turn?: string; settled?: boolean } {
    if (
      (update.sessionUpdate !== 'agent_message_chunk' &&
        update.sessionUpdate !== 'agent_thought_chunk') ||
      !update.messageId
    ) {
      return { turn }
    }
    const key = providerTimelineKeyPart(update.messageId)
    const owner = this.owners.get(key) ?? this.settled.get(key)
    if (owner) {
      return owner
    }
    if (turn !== undefined) {
      this.owners.set(key, { turn, settled: false })
    }
    return { turn }
  }

  key(turn: string, update: SessionUpdate): string | undefined {
    const state = this.turns.get(turn) ?? { ordinal: 0 }
    this.turns.set(turn, state)
    if (
      update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk'
    ) {
      if (
        ['user_message_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(
          update.sessionUpdate
        )
      ) {
        state.channel = undefined
      }
      return undefined
    }
    if (update.messageId) {
      return acpNamedTextKey(
        update.messageId,
        update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
      )
    }
    if (state.channel !== update.sessionUpdate) {
      state.ordinal += 1
      state.channel = update.sessionUpdate
    }
    return `turn-message:${JSON.stringify([turn, state.ordinal])}`
  }

  dispose(): void {
    this.turns.clear()
    this.owners.clear()
    this.settled.clear()
  }

  end(turn: string): void {
    this.turns.delete(turn)
    for (const [key, owner] of this.owners) {
      if (owner.turn === turn) {
        this.owners.delete(key)
        this.settled.set(key, { ...owner, settled: true })
      }
    }
  }
}
