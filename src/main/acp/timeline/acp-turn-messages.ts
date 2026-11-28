import { randomUUID } from 'node:crypto'
import type { AcpItemOwnership } from './acp-item-ownership'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import type { ProviderTimelineTextChannel } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { providerTimelineKeyPart } from '../../native-chat/agent-session-timeline/provider-timeline-identity'

/** One provider message may contain both reasoning and visible text. */
export function acpNamedTextKey(messageId: string, channel: ProviderTimelineTextChannel): string {
  return `message:${JSON.stringify([messageId, channel])}`
}

type MessagePosition = { ordinal: number; channel?: string }

export type AcpMessageOwner = { turn?: string; settled?: boolean }

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
  /** Turns an earlier app began: its saved messages hold the first ordinals, so these never reuse them. */
  private readonly carried = new Map<string, string>()
  /** The numbered message the last keyed update ended, until taken. */
  private ended: string | undefined
  /** The relayed prompt running, whose untagged updates are numbered in it. */
  private prompt: string | undefined

  constructor(private readonly owners: AcpItemOwnership) {}

  /** Keep trailing chunks on the provider message's original turn. */
  owner(
    turn: string | undefined,
    update: SessionUpdate,
    settled: (turn: string) => boolean
  ): AcpMessageOwner {
    if (
      (update.sessionUpdate !== 'agent_message_chunk' &&
        update.sessionUpdate !== 'agent_thought_chunk') ||
      !update.messageId
    ) {
      return { turn }
    }
    const key = `message:${providerTimelineKeyPart(update.messageId)}`
    const owner = this.owners.get(key)
    if (owner) {
      return { ...owner, settled: owner.settled || settled(owner.turn) }
    }
    return { turn, settled: turn !== undefined && settled(turn) }
  }

  observe(turn: string | undefined, update: SessionUpdate | undefined): void {
    if (
      turn !== undefined &&
      (update?.sessionUpdate === 'agent_message_chunk' ||
        update?.sessionUpdate === 'agent_thought_chunk') &&
      update.messageId
    ) {
      this.owners.remember(`message:${providerTimelineKeyPart(update.messageId)}`, turn)
    }
  }

  rejection(
    update: SessionUpdate | undefined,
    owner: AcpMessageOwner,
    threadId: string,
    turnId: string | undefined
  ): AcpTextDrop | undefined {
    if (
      !owner.settled ||
      (update?.sessionUpdate !== 'agent_message_chunk' &&
        update?.sessionUpdate !== 'agent_thought_chunk') ||
      !update.messageId
    ) {
      return undefined
    }
    const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
    return {
      reason: 'turn-settled',
      itemId: acpNamedTextKey(update.messageId, channel),
      channel,
      threadId,
      turnId
    }
  }

  /** `turn` undefined: an update its agent left untagged, numbered in `running`, the prompt still
   *  running, when it is the relayed one `opened` recorded (an adopted one resolves every update to
   *  it, so live and replayed numbering agree). */
  key(turn: string | undefined, update: SessionUpdate, running?: string): string | undefined {
    if (
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk') &&
      update.messageId
    ) {
      return acpNamedTextKey(
        update.messageId,
        update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
      )
    }
    const scope = turn ?? (running !== undefined && running === this.prompt ? running : undefined)
    if (scope === undefined || (turn !== undefined && !this.owners.isLive(turn))) {
      return undefined
    }
    const state = this.turns.get(scope) ?? { ordinal: 0 }
    this.turns.set(scope, state)
    const chunk =
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    const resets =
      chunk ||
      ['user_message_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(update.sessionUpdate)
    if (resets && state.channel !== undefined && state.channel !== update.sessionUpdate) {
      this.ended = this.position(scope, state.ordinal)
      state.channel = undefined
    }
    if (!chunk) {
      return undefined
    }
    if (state.channel !== update.sessionUpdate) {
      state.ordinal += 1
      state.channel = update.sessionUpdate
    }
    return this.position(scope, state.ordinal)
  }

  /** The numbered message the last keyed update ended: its stream can close now. */
  takeEnded(): string | undefined {
    const ended = this.ended
    this.ended = undefined
    return ended
  }

  private position(turn: string, ordinal: number): string {
    const carried = this.carried.get(turn)
    return `turn-message:${JSON.stringify(carried ? [turn, ordinal, carried] : [turn, ordinal])}`
  }

  /** A prompt opened. `numbered`: a relayed chat's, whose replay starts at its first line, so its
   *  untagged updates are numbered in it too. `salt`: a replay renumbering it (see `carry`). */
  opened(turn: string, numbered: boolean, salt?: string): void {
    this.prompt = numbered ? turn : undefined
    if (salt) {
      this.carry(turn, salt)
    }
  }

  /** `salt`: the same for every replay from one start, so a restart that replays it again rewrites
   *  the rows the last one wrote; a replay from elsewhere numbers rows of its own. */
  carry(turn: string, salt: string = randomUUID()): void {
    this.carried.set(turn, `carried:${salt}`)
  }

  dispose(): void {
    this.turns.clear()
    this.carried.clear()
    this.prompt = undefined
  }

  end(turn: string): void {
    this.turns.delete(turn)
    this.carried.delete(turn)
    if (this.prompt === turn) {
      this.prompt = undefined
    }
  }
}
