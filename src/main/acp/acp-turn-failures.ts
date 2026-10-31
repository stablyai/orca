import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { AgentSessionUsageLimit } from '../../shared/agent-session-usage-limit'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from './acp-errors'

const FAILED_STOP_REASONS = ['error', 'rate_limit']

function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

/** Prefer provider error details over generic messages such as Internal error. */
export function acpPromptErrorDetail(dialect: AcpDialect, error: AcpAgentError): string {
  // Orca's sign-in guidance already explains what to do.
  if (error instanceof AcpSignInPromptError) {
    return ''
  }
  return dialect.promptErrorDetail?.(error) ?? acpErrorDataWords(error.data) ?? error.message
}

// Structured metadata is not user-facing diagnostic text.
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

export function acpSignInRequiredFailure(
  dialect: AcpDialect,
  error: AcpAgentError
): SubmissionRejectionFact {
  const detail = providerDiagnostic(acpPromptErrorDetail(dialect, error), 'person')
  return agentSessionFailureFact('notSignedIn', detail ? { detail } : {})
}

/** Deduplicate failure rows by turn, accepting later reasons when earlier reports lacked one. */
export class AcpTurnFailures {
  private readonly rows = new BoundedMap<
    string,
    {
      text: string
      notSignedIn: boolean
      usageLimited: boolean
      usageLimit?: AgentSessionUsageLimit
    }
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

  ended(
    turn: string,
    stopReason: string,
    text: string | undefined,
    notSignedIn = false,
    usageLimit?: AgentSessionUsageLimit
  ): ProviderTimelineEvent[] {
    return acpStopReasonFailed(stopReason)
      ? this.row(turn, text, stopReason, notSignedIn, usageLimit)
      : []
  }

  row(
    turn: string,
    text: string | undefined,
    stopReason = 'error',
    notSignedIn = false,
    usageLimit?: AgentSessionUsageLimit
  ): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const detail = text === undefined ? undefined : providerDiagnostic(text, 'person')
    const diagnostic =
      (written?.text ? providerDiagnostic(written.text, 'person') : undefined) ?? detail
    const authenticationRequired = notSignedIn || written?.notSignedIn === true
    // Preserve rate-limit classification when a later prompt error omits the stop reason.
    const usageLimited =
      !authenticationRequired && (stopReason === 'rate_limit' || written?.usageLimited === true)
    const limit = usageLimit ?? written?.usageLimit
    if (
      written &&
      written.text === (diagnostic?.text ?? '') &&
      written.notSignedIn === authenticationRequired &&
      written.usageLimited === usageLimited &&
      written.usageLimit?.resetsAt === limit?.resetsAt &&
      written.usageLimit?.window === limit?.window
    ) {
      return []
    }
    this.rows.set(turn, {
      text: diagnostic?.text ?? '',
      notSignedIn: authenticationRequired,
      usageLimited,
      usageLimit: limit
    })
    const failure = authenticationRequired
      ? agentSessionFailureFact('notSignedIn', { detail: diagnostic })
      : usageLimited
        ? agentSessionFailureFact('usageLimitReached', {
            detail: diagnostic,
            usageLimit: limit
          })
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
