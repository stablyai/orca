import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome,
  PRSnapshotReply
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
import { deliverablePRBranchOutcome } from '../../client/lookup/pr-branch-read-resources'
import type { PreparedPRBranchRead } from '../../client/lookup/pr-for-branch-outcome'
import type { PRRefreshQueue, PRRefreshQueueEntry } from './pr-refresh-queue'
import type { PRRefreshPacing } from './pr-refresh-pacing'
import type { PRRefreshRetryState } from './pr-refresh-retry-state'

export const HOSTED_PR_COMPLETION_WAIT_MS = 25_000
const RETRY_MS = 10_000
const MAX_JOBS = 256
const MAX_WAITERS = 256
const JOB_LEASE_MS = 5 * 60_000

export type HostedPRReadJob = {
  prepared: PreparedPRBranchRead
  expiresAt: number
  running?: boolean
  promoteSelected: () => void
  listeners: Set<(outcome: PRRefreshOutcome | null) => void>
  finish: (outcome: PRRefreshOutcome | null) => void
}

export class HostedPRReadJobs {
  private readonly jobs = new Map<string, HostedPRReadJob>()
  private waiters = 0

  constructor(
    private readonly queue: PRRefreshQueue,
    private readonly pacing: PRRefreshPacing,
    private readonly retry: PRRefreshRetryState,
    private readonly wake: () => void,
    private readonly observe: (
      candidate: GitHubPRRefreshCandidate,
      outcome: PRRefreshOutcome
    ) => void,
    private readonly register: (entry: PRRefreshQueueEntry) => () => void = () => () => {}
  ) {}

  has(prepared: PreparedPRBranchRead): boolean {
    return this.jobs.has(`hosted::${prepared.key}`)
  }

  fresh(prepared: PreparedPRBranchRead): PRRefreshOutcome | null {
    return this.freshOutcome(prepared.cached())
  }

  freshOutcome(
    cached: ReturnType<PreparedPRBranchRead['cached']>,
    selected = true
  ): PRRefreshOutcome | null {
    if (!cached || cached.outcome.kind === 'upstream-error') {
      return null
    }
    const outcome = cached.outcome
    const interval =
      cached.quietIntervalMs ??
      reviewRefreshIntervalMs({
        state: outcome.kind === 'found' ? outcome.pr.state : null,
        checksStatus: outcome.kind === 'found' ? outcome.pr.checksStatus : null,
        hasReview: outcome.kind === 'found',
        selected
      })
    return interval === null || Date.now() - outcome.fetchedAt < interval ? outcome : null
  }

  private async legacyRead(
    prepared: PreparedPRBranchRead,
    candidate: GitHubPRRefreshCandidate
  ): Promise<PRRefreshOutcome> {
    const current = await prepared.reprepare()
    try {
      const result = await current.readResult((outcome) => {
        this.observe(candidate, outcome)
        return outcome
      })
      return result!.outcome
    } finally {
      current.release()
    }
  }

  private gateUntil(prepared: PreparedPRBranchRead): number {
    const outcome = prepared.cached()?.outcome
    return Math.max(
      this.queue.backgroundGateUntil(`hosted::${prepared.key}`),
      outcome?.kind === 'upstream-error'
        ? Math.max(outcome.nextAutoRetryAt ?? 0, outcome.retryDisabledUntil ?? 0)
        : 0
    )
  }

  retryAfterMs(prepared: PreparedPRBranchRead): number {
    return Math.max(
      RETRY_MS,
      this.pacing.nextBudgetDelay(),
      prepared.isCurrent() ? this.gateUntil(prepared) - Date.now() : 0
    )
  }

  async complete(
    prepared: PreparedPRBranchRead,
    candidate: GitHubPRRefreshCandidate,
    outcome: PRRefreshOutcome | null,
    acceptRevalidationOnly: boolean
  ): Promise<PRSnapshotReply> {
    if (outcome && !acceptRevalidationOnly) {
      return outcome
    }
    const current = prepared.isCurrent()
    if (current) {
      if (outcome && prepared.accepts(outcome)) {
        return outcome
      }
      const fresh = this.fresh(prepared)
      if (fresh) {
        return fresh
      }
    }
    const delay = this.retryAfterMs(prepared)
    const cached = current ? prepared.cached()?.outcome : null
    if (cached) {
      return cached.kind === 'upstream-error'
        ? cached
        : { ...cached, revalidation: { retryAfterMs: delay } }
    }
    return acceptRevalidationOnly
      ? { revalidation: { invalidated: true, retryAfterMs: delay } }
      : this.legacyRead(prepared, candidate)
  }

  async readCold(
    candidate: GitHubPRRefreshCandidate,
    prepared: PreparedPRBranchRead,
    acceptRevalidationOnly: boolean
  ): Promise<PRSnapshotReply> {
    try {
      const result = await prepared.readResult((outcome) => {
        const settled =
          acceptRevalidationOnly && outcome.kind === 'upstream-error'
            ? this.retry.settleProducerError(
                outcome,
                `hosted::${prepared.key}`,
                { ...candidate, isSelected: false },
                prepared,
                this.queue,
                true
              )
            : outcome
        this.observe(candidate, settled)
        return settled
      }, acceptRevalidationOnly)
      const outcome = result
        ? acceptRevalidationOnly
          ? deliverablePRBranchOutcome(prepared, result)
          : result.outcome
        : null
      return await this.complete(prepared, candidate, outcome, acceptRevalidationOnly)
    } finally {
      prepared.release()
    }
  }

  async read(
    prepared: PreparedPRBranchRead,
    candidate: GitHubPRRefreshCandidate,
    deadline: number,
    signal?: AbortSignal,
    acceptRevalidationOnly = false
  ): Promise<PRSnapshotReply> {
    if (!prepared.isCurrent()) {
      return this.complete(prepared, candidate, null, acceptRevalidationOnly)
    }
    const fresh = this.fresh(prepared)
    if (fresh) {
      return this.complete(prepared, candidate, fresh, acceptRevalidationOnly)
    }
    const key = `hosted::${prepared.key}`
    for (const [oldKey, old] of this.jobs) {
      if (old.expiresAt > Date.now()) {
        break
      }
      if (old.running) {
        continue
      }
      this.queue.delete(oldKey)
      old.finish(null)
    }
    const fallback = () => this.complete(prepared, candidate, null, acceptRevalidationOnly)
    const gate = this.gateUntil(prepared)
    if (prepared.cached()?.outcome.kind === 'upstream-error' && gate > Date.now()) {
      return fallback()
    }
    let job = this.jobs.get(key)
    if (!job) {
      if (this.jobs.size >= MAX_JOBS) {
        return fallback()
      }
      const listeners: HostedPRReadJob['listeners'] = new Set()
      const releaseHold = prepared.hold()
      const expiresAt = Date.now() + JOB_LEASE_MS
      const entry: PRRefreshQueueEntry = {
        key,
        candidate,
        aliases: new Map(),
        reason: 'swr',
        priority: candidate.isSelected ? 80 : prepared.cached()?.quietIntervalMs ? 20 : 40,
        dueAt: Math.min(expiresAt, Math.max(Date.now(), gate)),
        queuedAt: this.queue.nextOrder()
      }
      const settled = this.register(entry)
      job = {
        prepared,
        promoteSelected: () => {
          if (!entry.candidate.isSelected) {
            entry.candidate = { ...entry.candidate, isSelected: true }
            entry.priority = 80
            this.wake()
          }
        },
        expiresAt,
        listeners,
        finish: (outcome) => {
          settled()
          releaseHold()
          if (this.jobs.get(key) === job) {
            this.jobs.delete(key)
          }
          const listenersAtCompletion = Array.from(listeners)
          for (const listener of listenersAtCompletion) {
            listener(outcome)
          }
          listeners.clear()
        }
      }
      this.jobs.set(key, job)
      entry.hosted = job
      this.queue.set(key, entry)
      this.wake()
    }
    if (candidate.isSelected && !job.running) {
      job.promoteSelected()
    }
    if (
      !acceptRevalidationOnly ||
      this.waiters >= MAX_WAITERS ||
      Date.now() >= deadline ||
      Math.max(gate - Date.now(), this.pacing.nextBudgetDelay()) > deadline - Date.now()
    ) {
      return fallback()
    }
    const waitingJob = job
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const settle = (outcome: PRRefreshOutcome | null): void => {
        cleanup()
        void this.complete(prepared, candidate, outcome, acceptRevalidationOnly).then(
          resolve,
          reject
        )
      }
      const abort = (): void => {
        cleanup()
        reject(new Error('Pull request wait was cancelled'))
      }
      const cleanup = (): void => {
        if (!waitingJob.listeners.delete(settle)) {
          return
        }
        this.waiters -= 1
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      waitingJob.listeners.add(settle)
      this.waiters += 1
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => {
          cleanup()
          try {
            resolve(fallback())
          } catch (error) {
            reject(error)
          }
        },
        Math.max(0, deadline - Date.now())
      )
      if (signal?.aborted) {
        abort()
      }
    })
  }
  completeFromCache(entry: PRRefreshQueueEntry): boolean {
    const job = entry.hosted
    if (!job) {
      return false
    }
    const current = job.prepared.isCurrent()
    const fresh = current ? this.fresh(job.prepared) : null
    if (job.expiresAt > Date.now() && current && !fresh && job.prepared.canRetain()) {
      return false
    }
    this.queue.delete(entry.key)
    job.finish(current && job.expiresAt > Date.now() ? fresh : null)
    return true
  }
}
