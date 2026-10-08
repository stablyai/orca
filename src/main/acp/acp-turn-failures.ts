import { providerDiagnostic } from '../../shared/agent-session-failure'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { AcpAgentError } from './acp-errors'

/** Ends the provider failed, rather than ones it chose (a refusal, a token limit). */
const FAILED_STOP_REASONS = ['error', 'rate_limit']

function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

/** The provider's words in its error answer to `session/prompt`. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: AcpAgentError): string {
  return dialect.promptErrorDetail?.(error) ?? error.message
}

/** One error row per failed turn, in the provider's own words, as a Codex turn-ending error reads:
 *  the message was accepted and the turn ran, so it is no refusal. Providers send that reason several
 *  times (beside the end, after it, in the prompt's error answer), so a later copy only adds a
 *  reason the row still lacks. */
export class AcpTurnFailures {
  /** The reason each failed turn's row holds; '' for none yet. */
  private readonly rows = new BoundedMap<string, string>({ maxEntries: 128 })

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName: string | undefined
  ) {}

  has(turn: string): boolean {
    return this.rows.has(turn)
  }

  /** The row an end writes, if it failed. */
  ended(turn: string, stopReason: string, text: string | undefined): ProviderTimelineEvent[] {
    return acpStopReasonFailed(stopReason) ? this.row(turn, text, stopReason) : []
  }

  row(turn: string, text: string | undefined, stopReason = 'error'): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const detail = text === undefined ? undefined : providerDiagnostic(text, 'person')
    if (written !== undefined && (written !== '' || !detail)) {
      return []
    }
    this.rows.set(turn, detail?.text ?? '')
    return [
      {
        type: 'item.update',
        item: `turn-failure:${turn}`,
        body: {
          kind: 'status',
          tone: 'error',
          text:
            detail?.text ??
            this.dialect.failedTurnText?.(stopReason) ??
            `${this.agentName ?? 'The agent'} ended this turn with an error.`
        },
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}
