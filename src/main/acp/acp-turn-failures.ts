import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic,
  type ProviderDiagnostic
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { BoundedMap } from '../../shared/bounded-map'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
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

/** Whose turns these are: the provider session, and the agent its rows and Details name. */
export type AcpTurnFailureSource = {
  sessionId: string
  /** The agent's id, naming whose words a failed turn's Details hold. */
  agent?: string
  /** The agent's display name, for a failed turn the provider gave no words for. */
  agentName?: string
}

/** One error row per failed turn, named and quoting the agent's reason only when a person can read
 *  it, as a Codex turn-ending error reads: the message was accepted and the turn ran, so it is no
 *  refusal. The reason itself rides the row's Details. Providers send that reason several times
 *  (beside the end, after it, in the prompt's error answer), so a later copy only adds what the row
 *  still lacks: a reason, sign-in, or a usage limit. */
export class AcpTurnFailures {
  /** What each failed turn's row holds; `text` '' for no reason yet. */
  private readonly rows = new BoundedMap<
    string,
    { text: string; notSignedIn: boolean; rateLimited: boolean }
  >({ maxEntries: 128 })

  constructor(
    private readonly dialect: AcpDialect,
    private readonly source: AcpTurnFailureSource
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
    const rateLimited = stopReason === 'rate_limit'
    if (
      written !== undefined &&
      (written.text !== '' || !detail) &&
      (!notSignedIn || written.notSignedIn) &&
      (!rateLimited || written.rateLimited)
    ) {
      return []
    }
    const diagnostic =
      detail ?? (written?.text ? providerDiagnostic(written.text, 'person') : undefined)
    const agent = this.source.agent ?? 'acp'
    const state = {
      text: diagnostic?.text ?? '',
      notSignedIn: notSignedIn || written?.notSignedIn === true,
      rateLimited: rateLimited || written?.rateLimited === true
    }
    this.rows.set(turn, state)
    if (detail && detail.text !== written?.text) {
      console.warn(
        `[acp] ${this.source.agentName ?? agent} turn failed (${stopReason}):`,
        detail.text
      )
    }
    return [
      {
        type: 'item.update',
        item: `turn-failure:${turn}`,
        body: {
          kind: 'status',
          tone: 'error',
          ...this.words(state, diagnostic),
          ...(diagnostic
            ? {
                providerFrame: {
                  provider: agent,
                  kind: 'turn:failed',
                  payload: boundPayload(diagnostic.text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
                }
              }
            : {})
        },
        join: { thread: this.source.sessionId, turn }
      }
    ]
  }

  private words(
    { notSignedIn, rateLimited }: { notSignedIn: boolean; rateLimited: boolean },
    diagnostic: ProviderDiagnostic | undefined
  ) {
    // A usage limit the agent named is the cause to lead with; its own words stay in Details.
    if (!notSignedIn && (rateLimited || !diagnostic)) {
      return {
        text:
          this.dialect.failedTurnText?.(rateLimited ? 'rate_limit' : 'error') ??
          `${this.source.agentName ?? 'The agent'} ended this turn with an error.`
      }
    }
    return agentSessionFailureWords(
      agentSessionFailureFact(notSignedIn ? 'notSignedIn' : 'providerError', {
        detail: diagnostic
      }),
      { agentName: this.source.agentName, surface: 'row' }
    )
  }
}
