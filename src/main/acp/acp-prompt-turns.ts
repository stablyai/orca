import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'

export type AcpPromptTurn = {
  clientMessageId: string
  turn: string
  requestedAt: number
  opened: boolean
  durationMs?: number
}

/** An injected identity is known before any provider output arrives. */
export class AcpPromptTurns {
  current?: AcpPromptTurn
  /** The last prompt that ended, so its answer can still add the failure reason the end lacked. */
  last?: AcpPromptTurn

  constructor(
    private readonly sessionId: string,
    private readonly injected: boolean
  ) {}

  open(clientMessageId: string, at: number): { promptId: string; events: ProviderTimelineEvent[] } {
    if (this.current) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
    const turn = `prompt:${clientMessageId}`
    this.current = { clientMessageId, turn, requestedAt: at, opened: false }
    return { promptId: turn, events: this.injected ? [] : this.start(turn, at) }
  }

  finish(): void {
    this.last = this.current
    this.current = undefined
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
