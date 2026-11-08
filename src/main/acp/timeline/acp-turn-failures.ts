import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'

import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { BoundedMap } from '../../../shared/bounded-map'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../../native-chat/agent-session-timeline/provider-timeline-event'

import type { AcpDialect, AcpDialectNotification, AcpTurnEnding } from '../acp-dialects/acp-dialect'

import {
  acpStopReasonFailed,
  type AcpTurnFailureReport,
  type AcpTurnFailureEvidence,
  mergeAcpTurnFailureEvidence
} from '../turns/acp-turn-failure-evidence'

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
      ? agentSessionFailureFact('notSignedIn', {
          detail: diagnostic,
          ...(this.dialect.signInAccount ? { account: this.dialect.signInAccount } : {})
        })
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
