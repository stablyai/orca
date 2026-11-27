import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import {
  absorbAcpCompactionFrame,
  acpCompactionEnd,
  type AcpCompaction,
  type AcpCompactionFrame
} from '../turns/acp-compaction-turn'
import type { AcpDialect, AcpTurnEnding } from '../acp-dialects/acp-dialect'
import { acpPromptFailureEnding } from '../turns/acp-prompt-failure'
import type { AcpTurnFailures } from './acp-turn-failures'
import { hookOutcomeRowBody } from '../../../shared/agent-session/journal/agent-session-hook-outcome'
import type { SessionUpdate } from '../generated/acp-protocol.generated'

export type AcpPromptTurn = {
  clientMessageId: string
  turn: string
  requestedAt: number
  opened: boolean
  durationMs?: number
  compaction?: AcpCompaction
}

/**
 * `compactionTurn`: the host's `/compact` turn, already begun. `adopted`: an earlier app's prompt a
 * kept agent still runs, its turn saved already. `renumber`: the replay lacks that turn's first
 * lines, so its unnumbered messages take rows of their own, keyed by this.
 */
export type AcpPromptOpening = [compactionTurn?: string, adopted?: boolean, renumber?: string]

export const ACP_PROMPT_TURN_PREFIX = 'prompt:'
export const acpPromptTurnId = (clientMessageId: string): string =>
  `${ACP_PROMPT_TURN_PREFIX}${clientMessageId}`

export class AcpPromptTurns {
  current?: AcpPromptTurn
  /** Retain the ended prompt so its reply can supply a late failure reason. */
  last?: AcpPromptTurn

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName?: string
  ) {}

  failure(
    clientMessageId: string,
    error: Error,
    at: number,
    failures: AcpTurnFailures
  ): AcpTurnEnding | ProviderTimelineEvent[] {
    const ending = acpPromptFailureEnding(this.dialect, error, at)
    if (this.current?.clientMessageId !== clientMessageId) {
      // A late answer may supply a failure reason missing from the provider's end.
      return this.last?.clientMessageId === clientMessageId && failures.has(this.last.turn)
        ? failures.row(this.last.turn, ending)
        : []
    }
    return ending
  }

  /** `compactionTurn`: reuse the host's already-open command turn for compaction. `adopted`: an
   *  earlier app's prompt a kept agent still runs; the chat shows its turn already. */
  open(
    clientMessageId: string,
    at: number,
    compactionTurn?: string,
    adopted = false
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
    const turn = acpPromptTurnId(clientMessageId)
    this.current = { clientMessageId, turn, requestedAt: at, opened: adopted }
    const injected = this.dialect.injectedPromptIdentity === true
    return { promptId: turn, events: injected || adopted ? [] : this.start(turn, at) }
  }

  /** Hook refusal ends immediately; normal completion waits for the prompt reply. */
  awaitsReply(
    turn: string,
    end: Pick<AcpTurnEnding, 'stopReason' | 'durationMs' | 'hookBlock'>
  ): boolean {
    if (
      this.current?.turn !== turn ||
      !['end_turn', 'cancelled'].includes(end.stopReason) ||
      end.hookBlock
    ) {
      return false
    }
    this.current.durationMs = end.durationMs
    return true
  }

  compacting(turn: string | undefined): AcpPromptTurn | undefined {
    return turn !== undefined && this.current?.turn === turn && this.current.compaction
      ? this.current
      : undefined
  }

  /** True suppresses rendering the compaction's frame. */
  absorbCompaction(
    turn: string | undefined,
    extension: AcpCompactionFrame | undefined,
    update: SessionUpdate | undefined
  ): boolean {
    const prompt = this.compacting(turn)
    return prompt !== undefined && absorbAcpCompactionFrame(prompt, extension, update, this.dialect)
  }

  endCompaction(
    turn: string,
    ending: AcpTurnEnding,
    failures: Pick<AcpTurnFailures, 'write'>
  ): ProviderTimelineEvent[] | undefined {
    const prompt = this.compacting(turn)
    if (!prompt?.compaction) {
      return undefined
    }
    return acpCompactionEnd({
      ...prompt,
      ...ending,
      failures,
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

  /** Only discard refusals received before the turn opens. */
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

/** Hook denial completes the turn; a stable row key deduplicates repeated endings. */
export function acpTurnEndEvents(
  thread: string,
  turn: string,
  { stopReason, at, durationMs, hookBlock }: AcpTurnEnding
): ProviderTimelineEvent[] {
  const end = acpTurnEnd(turn, hookBlock ? 'end_turn' : stopReason, at, durationMs)
  const body = hookBlock && hookOutcomeRowBody('blocked', [hookBlock.reason ?? ''])
  return body
    ? [{ type: 'item.update', item: `hook-block:${turn}`, body, join: { thread, turn } }, end]
    : [end]
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
