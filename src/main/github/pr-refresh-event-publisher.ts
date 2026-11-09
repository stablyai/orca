import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import { recordCoalescedCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { prRefreshRenderers } from './pr-refresh-renderer-port'

export type PRRefreshOutcomeObserver = (
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
) => void

const DIAGNOSTIC_BREADCRUMB_MIN_INTERVAL_MS = 30_000

export class PRRefreshEventPublisher {
  private sequence = 0
  private readonly observers = new Set<PRRefreshOutcomeObserver>()
  private readonly counters = { enqueued: 0, coalesced: 0, skipped: 0, backgroundPauses: 0 }

  addOutcomeObserver(observer: PRRefreshOutcomeObserver): () => void {
    const registered: PRRefreshOutcomeObserver = (...args) => observer(...args)
    this.observers.add(registered)
    return () => this.observers.delete(registered)
  }

  /** Every read of a PR reaches every observer once, whatever surface caused it. */
  observe(candidate: GitHubPRRefreshCandidate, outcome: PRRefreshOutcome): void {
    for (const observer of this.observers) {
      try {
        observer(candidate, outcome)
      } catch (error) {
        // One observer's failure must not hide the read from the others or fail the refresh.
        console.warn('[pr-refresh] outcome observer failed', error)
      }
    }
  }

  nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  broadcast(event: Omit<GitHubPRRefreshEvent, 'sequence'>, sequenceOverride?: number): void {
    const payload = {
      ...event,
      sequence: sequenceOverride ?? this.nextSequence()
    } as GitHubPRRefreshEvent
    prRefreshRenderers().sendToTrustedUI('gh:prRefreshEvent', payload)
  }

  record(
    event: 'enqueued' | 'coalesced' | 'skipped' | 'background-pause',
    reason: GitHubPRRefreshReason,
    skippedReason?: GitHubPRRefreshSkippedReason
  ): void {
    if (event === 'background-pause') {
      this.counters.backgroundPauses += 1
    } else {
      this.counters[event] += 1
    }
    recordCoalescedCrashBreadcrumb({
      name: 'pr_refresh_queue',
      coalesceKey: `pr-refresh-queue:${event}:${reason}:${skippedReason ?? ''}`,
      minIntervalMs: DIAGNOSTIC_BREADCRUMB_MIN_INTERVAL_MS,
      data: {
        event,
        reason,
        ...(skippedReason ? { skippedReason } : {}),
        enqueued: this.counters.enqueued,
        coalesced: this.counters.coalesced,
        skipped: this.counters.skipped,
        backgroundPauses: this.counters.backgroundPauses
      }
    })
  }
}
