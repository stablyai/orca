import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { AcpCompaction } from './acp-compaction-turn'
import type { AgentSessionUsageLimit } from '../../shared/agent-session/failures/agent-session-usage-limit'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect, AcpDialectNotification, AcpTurnEnding } from './acp-dialects/acp-dialect'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from './acp-errors'

const FAILED_STOP_REASONS = ['error', 'rate_limit']

function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

export type AcpTurnFailureEvidence = {
  text: string
  notSignedIn: boolean
  usageLimited: boolean
  usageLimit?: AgentSessionUsageLimit
}

/** Keep the first diagnostic and established quota cause when a later RPC error is generic. */
export function mergeAcpTurnFailureEvidence(
  previous: AcpTurnFailureEvidence | undefined,
  stopReason: string,
  text: string | undefined,
  notSignedIn = false,
  usageLimit?: AgentSessionUsageLimit
): AcpTurnFailureEvidence {
  const authenticationRequired = notSignedIn || previous?.notSignedIn === true
  return {
    text:
      previous?.text ||
      (text === undefined ? '' : (providerDiagnostic(text, 'person')?.text ?? '')),
    notSignedIn: authenticationRequired,
    usageLimited:
      !authenticationRequired && (stopReason === 'rate_limit' || previous?.usageLimited === true),
    usageLimit: usageLimit ?? previous?.usageLimit
  }
}

type FailurePlacement = { join: ProviderTimelineJoin; previous?: AcpTurnFailureEvidence }

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
  private readonly rows = new BoundedMap<string, AcpTurnFailureEvidence>({
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

  notification(
    turn: string | undefined,
    extension: AcpDialectNotification | undefined
  ): ProviderTimelineEvent[] {
    return turn &&
      extension?.disposition === 'map' &&
      (extension.failureDetail || extension.failure)
      ? this.row(
          turn,
          extension.failureDetail ?? extension.failure?.failureDetail,
          extension.failure?.stopReason
        )
      : []
  }

  ended(turn: string, ending: AcpTurnEnding, compaction?: AcpCompaction): ProviderTimelineEvent[] {
    const { stopReason, failureDetail, notSignedIn, usageLimit } = ending
    const placement = compaction
      ? { join: { thread: this.sessionId }, previous: compaction.failure }
      : undefined
    return acpStopReasonFailed(stopReason)
      ? this.row(turn, failureDetail, stopReason, notSignedIn, usageLimit, placement)
      : []
  }

  row(
    turn: string,
    text: string | undefined,
    stopReason = 'error',
    notSignedIn = false,
    usageLimit?: AgentSessionUsageLimit,
    placement?: FailurePlacement
  ): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const evidence = mergeAcpTurnFailureEvidence(
      written ?? placement?.previous,
      stopReason,
      text,
      notSignedIn,
      usageLimit
    )
    const { notSignedIn: authenticationRequired, usageLimited, usageLimit: limit } = evidence
    const diagnostic = providerDiagnostic(evidence.text, 'person')
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
    this.rows.set(turn, evidence)
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
        join: placement?.join ?? { thread: this.sessionId, turn }
      }
    ]
  }
}
