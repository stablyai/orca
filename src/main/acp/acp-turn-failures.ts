import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from './acp-errors'

/** Ends the provider failed, rather than ones it chose (a refusal, a token limit). */
const FAILED_STOP_REASONS = ['error', 'rate_limit']

function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

/** The provider's words in its error answer to `session/prompt`. Agents often answer a generic
 *  message ("Internal error") and keep their own words in `data`. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: AcpAgentError): string {
  // Empty: the sign-in sentence alone says what to do.
  if (error instanceof AcpSignInPromptError) {
    return ''
  }
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

/** A sign-in refusal in the agent's own words. */
export function acpSignInRequiredFailure(
  dialect: AcpDialect,
  error: AcpAgentError
): SubmissionRejectionFact {
  const detail = providerDiagnostic(acpPromptErrorDetail(dialect, error), 'person')
  return agentSessionFailureFact('notSignedIn', detail ? { detail } : {})
}

/** One error row per failed turn, in the provider's own words, as a Codex turn-ending error reads:
 *  the message was accepted and the turn ran, so it is no refusal. Providers send that reason several
 *  times (beside the end, after it, in the prompt's error answer), so a later copy only adds a
 *  reason the row still lacks. */
export class AcpTurnFailures {
  /** The reason each failed turn's row holds; '' for none yet. */
  private readonly rows = new BoundedMap<
    string,
    { text: string; notSignedIn: boolean; usageLimited: boolean }
  >({
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
    const diagnostic =
      (written?.text ? providerDiagnostic(written.text, 'person') : undefined) ?? detail
    const authenticationRequired = notSignedIn || written?.notSignedIn === true
    // A later copy of the reason (the prompt's error answer) names no stop reason of its own.
    const usageLimited =
      !authenticationRequired && (stopReason === 'rate_limit' || written?.usageLimited === true)
    if (
      written &&
      written.text === (diagnostic?.text ?? '') &&
      written.notSignedIn === authenticationRequired &&
      written.usageLimited === usageLimited
    ) {
      return []
    }
    this.rows.set(turn, {
      text: diagnostic?.text ?? '',
      notSignedIn: authenticationRequired,
      usageLimited
    })
    const failure = authenticationRequired
      ? agentSessionFailureFact('notSignedIn', { detail: diagnostic })
      : usageLimited
        ? agentSessionFailureFact('usageLimitReached', { detail: diagnostic })
        : null
    return [
      {
        type: 'item.update',
        item: `turn-failure:${turn}`,
        body: {
          kind: 'status',
          tone: usageLimited ? 'warning' : 'error',
          ...(failure
            ? agentSessionFailureWords(failure, { agentName: this.agentName, surface: 'row' })
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
