import {
  boundPayload,
  PROVIDER_FRAME_PAYLOAD_LIMITS
} from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import {
  agentSessionFailureFact,
  providerDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'

import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../../native-chat/agent-session-timeline/provider-timeline-event'

import type { AcpDialect, AcpDialectNotification, AcpTurnEnding } from '../acp-dialects/acp-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import { ACP_SUBSTANTIVE_UPDATES } from './acp-session-update'

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
  private retryRun?: { item: string; turn: string | undefined; attempt: number }
  private retryRuns = 0
  private lost?: Error

  constructor(
    private readonly sessionId: string,
    private readonly dialect: AcpDialect,
    private readonly agentName: string | undefined
  ) {}

  has(turn: string): boolean {
    return this.rows.has(turn)
  }

  /** The agent's notice, once, that it dropped the session although its prompt then ended. */
  takeSessionLoss(): Error | undefined {
    const lost = this.lost
    this.lost = undefined
    return lost
  }

  notification(
    turn: string | undefined,
    extension: AcpDialectNotification | undefined
  ): ProviderTimelineEvent[] {
    const notice = extension?.disposition === 'map' ? extension.failure?.failureDetail : undefined
    if (notice && this.dialect.sessionLostNotice?.(notice)) {
      this.lost = new Error(notice)
    }
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

  /** Revise one retrying row per run of retry notices; any other turn content ends the run. */
  retry(
    update: SessionUpdate,
    turn: string | undefined,
    at: number,
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] | undefined {
    const retry = this.dialect.providerRetry?.(update)
    if (!retry) {
      if (retry === null || ACP_SUBSTANTIVE_UPDATES.includes(update.sessionUpdate)) {
        this.retryRun = undefined
      }
      return undefined
    }
    if (!this.retryRun || this.retryRun.turn !== turn) {
      // History gives each turn a fresh translator, often at one time, so the turn keeps keys apart.
      this.retryRuns += 1
      this.retryRun = {
        item: `provider-retry:${JSON.stringify([turn ?? null, at, this.retryRuns])}`,
        turn,
        attempt: 0
      }
    }
    this.retryRun.attempt = retry.attempt ?? this.retryRun.attempt + 1
    const failure = agentSessionFailureFact('providerRetrying', {
      retry: { ...retry, attempt: this.retryRun.attempt }
    })
    return [
      {
        type: 'item.update',
        item: this.retryRun.item,
        body: {
          kind: 'status',
          tone: 'warning',
          ...agentSessionFailureWords(failure, { agentName: this.agentName, surface: 'row' })
        },
        join
      }
    ]
  }

  /** A failure reported mid-turn still fails a turn the agent closes with end_turn. */
  ending(turn: string, reported: AcpTurnEnding): AcpTurnEnding {
    return reported.stopReason === 'end_turn' && this.rows.has(turn)
      ? { ...reported, stopReason: 'error' }
      : reported
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
                  `${this.agentName ?? 'The agent'} ended this turn with an error.`,
                // The agent's own line, under Details, behind the sentence drawn from it.
                ...(evidence.frame && {
                  providerFrame: {
                    provider: this.agentName ?? 'agent',
                    kind: 'failure-notice',
                    payload: boundPayload(evidence.frame, PROVIDER_FRAME_PAYLOAD_LIMITS)
                  }
                })
              })
        },
        join
      }
    ]
  }
}
