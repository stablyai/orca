import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError, AcpAuthRequiredError } from './acp-errors'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/** Ends the provider failed, rather than ones it chose (a refusal, a token limit). */
const FAILED_STOP_REASONS = ['error', 'rate_limit']

function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

/** The provider's words in its error answer to `session/prompt`. Agents often answer a generic
 *  message ("Internal error") and keep their own words in `data`. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: AcpAgentError): string {
  return dialect.promptErrorDetail?.(error) ?? acpErrorDataWords(error.data) ?? error.message
}

// Other structured data is metadata (service, error class names), not words for a person.
function acpErrorDataWords(data: unknown): string | undefined {
  const words =
    typeof data === 'string'
      ? data
      : typeof data === 'object' && data !== null && 'details' in data
        ? data.details
        : undefined
  return typeof words === 'string' && words.trim() ? words : undefined
}

export function acpAuthenticationRequired(dialect: AcpDialect, error: unknown): boolean {
  return (
    error instanceof AcpAuthRequiredError ||
    (error instanceof AcpAgentError && dialect.authenticationRequired?.(error) === true)
  )
}

export function acpSignInRequiredRefusal(
  agent: string,
  dialect: AcpDialect,
  error: AcpAgentError
): AgentSessionAcquisitionRefusal {
  return withProviderDiagnostic(
    new AgentSessionAcquisitionRefusal(
      `${agent} reported that it is not signed in: ${error.message}`,
      'notSignedIn'
    ),
    providerDiagnostic(acpPromptErrorDetail(dialect, error), 'person')
  )
}

/** One error row per failed turn, in the provider's own words, as a Codex turn-ending error reads:
 *  the message was accepted and the turn ran, so it is no refusal. Providers send that reason several
 *  times (beside the end, after it, in the prompt's error answer), so a later copy only adds a
 *  reason the row still lacks. */
export class AcpTurnFailures {
  /** The reason each failed turn's row holds; '' for none yet. */
  private readonly rows = new BoundedMap<string, { text: string; notSignedIn: boolean }>({
    maxEntries: 128
  })

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName: string | undefined
  ) {}

  has(turn: string): boolean {
    return this.rows.has(turn)
  }

  /** The row an end writes, if it failed. */
  ended(
    turn: string,
    stopReason: string,
    text: string | undefined,
    notSignedIn = false
  ): ProviderTimelineEvent[] {
    return acpStopReasonFailed(stopReason) ? this.row(turn, text, stopReason, notSignedIn) : []
  }

  row(
    turn: string,
    text: string | undefined,
    stopReason = 'error',
    notSignedIn = false
  ): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const detail = text === undefined ? undefined : providerDiagnostic(text, 'person')
    if (
      written !== undefined &&
      (written.text !== '' || !detail) &&
      (!notSignedIn || written.notSignedIn)
    ) {
      return []
    }
    const diagnostic =
      detail ?? (written?.text ? providerDiagnostic(written.text, 'person') : undefined)
    const authenticationRequired = notSignedIn || written?.notSignedIn === true
    this.rows.set(turn, {
      text: diagnostic?.text ?? '',
      notSignedIn: authenticationRequired
    })
    return [
      {
        type: 'item.update',
        item: `turn-failure:${turn}`,
        body: {
          kind: 'status',
          tone: 'error',
          ...(authenticationRequired
            ? agentSessionFailureWords(
                agentSessionFailureFact('notSignedIn', { detail: diagnostic }),
                { agentName: this.agentName, surface: 'row' }
              )
            : {
                text:
                  diagnostic?.text ??
                  this.dialect.failedTurnText?.(stopReason) ??
                  `${this.agentName ?? 'The agent'} ended this turn with an error.`
              })
        },
        join: { thread: this.sessionId, turn }
      }
    ]
  }
}
