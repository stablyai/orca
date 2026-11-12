import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRWatchStorage } from './pr-watch-storage'
import { schedulePRWatchRead } from '../pull-requests/refresh/pr-refresh-coordinator'
import { prWatchQueueKey, type PRWatchJob } from '../pull-requests/refresh/pr-refresh-watch-jobs'
import { readPRHeadCheckRollup } from './pr-head-check-read'
import { parsePRKey } from './pr-watch-types'

const HEAD_CHECKS_INTERVAL_MS = 120_000
const SPACING_MS = 10_000

/** Heads a PR moved off before their checks were final, each read by SHA until it is or expires. */
export class PREarlierHeadJobs {
  private stopped = false
  private readonly jobs = new Set<string>()

  constructor(
    private readonly deps: {
      database: PRWatchStorage
      /** Records the head's read; true once its checks are final. */
      apply: (prKey: string, headSha: string, rollup: readonly unknown[]) => Promise<boolean>
      logger: Pick<StructuredAgentSessionLogger, 'warn'>
      now: () => number
    }
  ) {}

  has(job: PRWatchJob): boolean {
    return this.jobs.has(prWatchQueueKey(job))
  }

  clear(): void {
    this.stopped = true
    this.jobs.clear()
  }

  /** Every moved head of the PR not already queued; `index` spaces a restart's jobs. */
  async scheduleMoved(
    prKey: string,
    candidate: GitHubPRRefreshCandidate,
    index = 0
  ): Promise<number> {
    const heads = await this.deps.database.read({ kind: 'heads', prKey })
    if (this.stopped) {
      return index
    }
    for (const head of heads) {
      const job = { prKey, headSha: head.headSha }
      if (head.movedAt !== null && !this.has(job)) {
        this.jobs.add(prWatchQueueKey(job))
        schedulePRWatchRead(job, candidate, this.deps.now() + SPACING_MS * index++)
      }
    }
    return index
  }

  async read(
    job: Required<PRWatchJob>,
    candidate: GitHubPRRefreshCandidate
  ): Promise<number | null> {
    const { database, now } = this.deps
    const head = (await database.read({ kind: 'heads', prKey: job.prKey })).find(
      (row) => row.headSha === job.headSha
    )
    if (this.stopped) {
      return null
    }
    const pr = parsePRKey(job.prKey)
    if (!head || !pr || (head.expiresAt !== null && head.expiresAt <= now())) {
      await database.write({ kind: 'delete-head', prKey: job.prKey, headSha: job.headSha })
      this.jobs.delete(prWatchQueueKey(job))
      return null
    }
    try {
      const rollup = await readPRHeadCheckRollup(candidate, pr, job.headSha)
      if (this.stopped) {
        return null
      }
      if (await this.deps.apply(job.prKey, job.headSha, rollup)) {
        this.jobs.delete(prWatchQueueKey(job))
        return null
      }
    } catch (error) {
      this.deps.logger.warn('reading an earlier head’s checks failed', {
        scope: 'pr-watch',
        prKey: job.prKey,
        error
      })
    }
    return this.stopped ? null : now() + HEAD_CHECKS_INTERVAL_MS
  }
}
