import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import type { AgentSessionUsageLimit } from '../../shared/agent-session/failures/agent-session-usage-limit'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect, AcpDialectNotification, AcpTurnEnding } from './acp-dialects/acp-dialect'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from './acp-errors'

const FAILED_STOP_REASONS = ['error', 'rate_limit']

export function acpStopReasonFailed(stopReason: string): boolean {
  return FAILED_STOP_REASONS.includes(stopReason)
}

export type AcpTurnFailureReport = Pick<
  AcpTurnEnding,
  | 'stopReason'
  | 'failureDetail'
  | 'notSignedIn'
  | 'modelNotSelected'
  | 'usageLimit'
  | 'providerFailure'
>

export type AcpTurnFailureEvidence = {
  text: string
  notSignedIn: boolean
  modelNotSelected?: boolean
  usageLimited: boolean
  providerFailure: boolean
  usageLimit?: AgentSessionUsageLimit
}

/** Keep the first diagnostic and established causes when a later RPC error is generic. */
export function mergeAcpTurnFailureEvidence(
  previous: AcpTurnFailureEvidence | undefined,
  {
    stopReason,
    failureDetail: text,
    notSignedIn,
    modelNotSelected,
    usageLimit,
    providerFailure
  }: AcpTurnFailureReport
): AcpTurnFailureEvidence {
  const authenticationRequired = notSignedIn === true || previous?.notSignedIn === true
  return {
    text:
      previous?.text ||
      (text === undefined ? '' : (providerDiagnostic(text, 'person')?.text ?? '')),
    notSignedIn: authenticationRequired,
    modelNotSelected: modelNotSelected === true || previous?.modelNotSelected === true,
    usageLimited:
      !authenticationRequired && (stopReason === 'rate_limit' || previous?.usageLimited === true),
    providerFailure: providerFailure === true || previous?.providerFailure === true,
    usageLimit: usageLimit ?? previous?.usageLimit
  }
}

/** Agents report their own refusals as errors too; only these causes make a failure the provider's. */
export function acpProviderFailed(evidence: AcpTurnFailureEvidence): boolean {
  return (
    evidence.notSignedIn ||
    evidence.modelNotSelected === true ||
    evidence.usageLimited ||
    evidence.providerFailure
  )
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

/** What a failed prompt request says about its turn's ending. */
export function acpPromptFailureEnding(
  dialect: AcpDialect,
  error: Error,
  at: number
): AcpTurnEnding {
  const agentError = error instanceof AcpAgentError ? error : undefined
  const failure = agentError ? dialect.promptFailure?.(agentError, at) : undefined
  return {
    ...failure,
    stopReason: failure?.stopReason ?? 'error',
    at,
    failureDetail: agentError ? acpPromptErrorDetail(dialect, agentError) : undefined,
    notSignedIn: acpAuthenticationRequired(dialect, error),
    modelNotSelected: agentError ? dialect.modelCommand?.noModel(agentError) === true : false
  }
}

export function acpSignInRequiredFailure(
  dialect: AcpDialect,
  error: AcpAgentError
): SubmissionRejectionFact {
  const detail = providerDiagnostic(acpPromptErrorDetail(dialect, error), 'person')
  return agentSessionFailureFact('notSignedIn', detail ? { detail } : {})
}

/** Why the agent refused a prompt, as the person is told; a missing model outranks its sign-in wording. */
export function acpPromptRejection(
  refusal: string,
  signedOut: boolean,
  noModel: SubmissionRejectionFact | undefined
): SubmissionRejectionFact {
  if (noModel) {
    return noModel
  }
  const detail = providerDiagnostic(refusal, 'person')
  return agentSessionFailureFact(
    signedOut ? 'notSignedIn' : 'providerRejected',
    detail ? { detail } : {}
  )
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
      ? this.row(turn, {
          ...extension.failure,
          stopReason: extension.failure?.stopReason ?? 'error',
          failureDetail: extension.failureDetail ?? extension.failure?.failureDetail
        })
      : []
  }

  ended(turn: string, ending: AcpTurnEnding): ProviderTimelineEvent[] {
    return acpStopReasonFailed(ending.stopReason) ? this.row(turn, ending) : []
  }

  row(turn: string, report: AcpTurnFailureReport): ProviderTimelineEvent[] {
    const evidence = mergeAcpTurnFailureEvidence(this.rows.peek(turn), report)
    return this.write(turn, evidence, { thread: this.sessionId, turn }, report.stopReason)
  }

  /** Render already merged evidence; a host command passes its thread-only join. */
  write(
    turn: string,
    evidence: AcpTurnFailureEvidence,
    join: ProviderTimelineJoin,
    stopReason = 'error'
  ): ProviderTimelineEvent[] {
    const written = this.rows.peek(turn)
    const { notSignedIn: authenticationRequired, usageLimited, usageLimit: limit } = evidence
    const diagnostic = providerDiagnostic(evidence.text, 'person')
    if (
      written &&
      written.text === (diagnostic?.text ?? '') &&
      written.notSignedIn === authenticationRequired &&
      written.modelNotSelected === evidence.modelNotSelected &&
      written.usageLimited === usageLimited &&
      written.usageLimit?.resetsAt === limit?.resetsAt &&
      written.usageLimit?.window === limit?.window
    ) {
      return []
    }
    this.rows.set(turn, evidence)
    const failure = authenticationRequired
      ? agentSessionFailureFact('notSignedIn', { detail: diagnostic })
      : evidence.modelNotSelected
        ? agentSessionFailureFact('modelNotSelected')
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
        join
      }
    ]
  }
}
