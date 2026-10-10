import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  absorbAcpCompactionFrame,
  acpCompactionEnd,
  type AcpCompaction,
  type AcpCompactionFrame
} from './acp-compaction-turn'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { SessionUpdate } from './generated/acp-protocol.generated'

export type AcpPromptTurn = {
  clientMessageId: string
  turn: string
  requestedAt: number
  opened: boolean
  durationMs?: number
  /** A `/compact` running as the turn the host opened for it. */
  compaction?: AcpCompaction
}

/** An injected identity is known before any provider output arrives. */
export class AcpPromptTurns {
  current?: AcpPromptTurn
  /** The last prompt that ended, so its answer can still add the failure reason the end lacked. */
  last?: AcpPromptTurn

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName?: string
  ) {}

  /** `compactionTurn` runs a `/compact` as the command turn the host already opened, which its
   *  frames join and its answer ends. */
  open(
    clientMessageId: string,
    at: number,
    compactionTurn?: string
  ): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.current) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    if (compactionTurn !== undefined) {
      this.current = {
        clientMessageId,
        turn: compactionTurn,
        requestedAt: at,
        opened: true,
        compaction: { reply: '' }
      }
      return { promptId: compactionTurn, events: [] }
    }
    const turn = `prompt:${clientMessageId}`
    this.current = { clientMessageId, turn, requestedAt: at, opened: false }
    const injected = this.dialect.injectedPromptIdentity === true
    return { promptId: turn, events: injected ? [] : this.start(turn, at) }
  }

  /** The running `/compact`, when `turn` is its turn. */
  compacting(turn: string | undefined): AcpPromptTurn | undefined {
    return turn !== undefined && this.current?.turn === turn && this.current.compaction
      ? this.current
      : undefined
  }

  /** True for a frame the running compaction `turn` read as its own. */
  absorbCompaction(
    turn: string | undefined,
    extension: AcpCompactionFrame | undefined,
    update: SessionUpdate | undefined
  ): boolean {
    const prompt = this.compacting(turn)
    return prompt !== undefined && absorbAcpCompactionFrame(prompt, extension, update)
  }

  /** The running compaction's result row and end, when `turn` is its turn. */
  endCompaction(
    turn: string,
    ending: { stopReason: string; at: number; failureDetail?: string; notSignedIn?: boolean }
  ): ProviderTimelineEvent[] | undefined {
    const prompt = this.compacting(turn)
    if (!prompt?.compaction) {
      return undefined
    }
    return acpCompactionEnd({
      ...prompt,
      ...ending,
      compaction: prompt.compaction,
      thread: this.sessionId,
      dialect: this.dialect,
      agentName: this.agentName
    })
  }

  finish(): void {
    this.last = this.current
    this.current = undefined
  }

  /** Forgets a prompt the agent refused before its turn opened; false for any other. */
  refuse(clientMessageId: string): boolean {
    if (this.current?.clientMessageId !== clientMessageId || this.current.opened) {
      return false
    }
    this.current = undefined
    return true
  }

  start(turn: string, at: number): ProviderTimelineEvent[] {
    const prompt = this.current
    if (prompt?.turn !== turn || prompt.opened) {
      return []
    }
    prompt.opened = true
    return [
      { type: 'turn.open', turn, at },
      {
        type: 'input.accepted',
        clientMessageId: prompt.clientMessageId,
        requestedAt: prompt.requestedAt,
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}

export function acpTurnEnd(
  turn: string,
  stopReason: string,
  at: number,
  durationMs?: number
): ProviderTimelineEvent {
  return {
    type: 'turn.end',
    turn,
    at,
    state: stopReason === 'cancelled' ? 'interrupted' : 'completed',
    ...(stopReason === 'end_turn'
      ? { outcome: 'success' as const }
      : stopReason === 'cancelled'
        ? { outcome: 'cancellation' as const }
        : ['refusal', 'max_tokens', 'max_turn_requests', 'error', 'rate_limit'].includes(stopReason)
          ? { outcome: 'failure' as const }
          : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  }
}
