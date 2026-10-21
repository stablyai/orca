import { BoundedMap } from '../../shared/bounded-map'
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

/** Stable turn-relative message positions. */
export class AcpTurnMessages {
  private readonly turns = new BoundedMap<string, MessagePosition>({ maxEntries: 128 })
  private readonly owners = new BoundedMap<string, MessageOwner>({ maxEntries: 128 })

  /** Channel items inherit the provider message's first turn, including trailing chunks. */
  owner(turn: string | undefined, update: SessionUpdate): { turn?: string; settled?: boolean } {
    if (
      (update.sessionUpdate !== 'agent_message_chunk' &&
        update.sessionUpdate !== 'agent_thought_chunk') ||
      !update.messageId
    ) {
      return { turn }
    }
    const key = providerTimelineKeyPart(update.messageId)
    const owner = this.owners.get(key)
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
      if (['tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate)) {
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

  end(turn: string): void {
    this.turns.delete(turn)
    for (const owner of this.owners.values()) {
      if (owner.turn === turn) {
        owner.settled = true
      }
    }
  }
}
