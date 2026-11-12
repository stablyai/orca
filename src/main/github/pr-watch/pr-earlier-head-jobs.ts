import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/database/journal-host-database'
import { schedulePRWatchRead } from '../pr-refresh-coordinator'
import { prWatchQueueKey, type PRWatchJob } from '../pr-refresh-watch-jobs'
import { deletePRPendingHead, readPRPendingHeads } from './pr-check-event-tables'
import { readPRHeadCheckRollup } from './pr-head-check-read'
import { parsePRKey } from './pr-watch-types'

const HEAD_CHECKS_INTERVAL_MS = 120_000
const SPACING_MS = 10_000

/** Heads a PR moved off before their checks were final, each read by SHA until it is or expires. */
export class PREarlierHeadJobs {
  private readonly jobs = new Set<string>()

  constructor(
    private readonly deps: {
      database: JournalHostDatabase
      /** Records the head's read; true once its checks are final. */
      apply: (prKey: string, headSha: string, rollup: readonly unknown[]) => boolean
      logger: Pick<StructuredAgentSessionLogger, 'warn'>
      now: () => number
    }
  ) {}

  has(job: PRWatchJob): boolean {
    return this.jobs.has(prWatchQueueKey(job))
  }

  clear(): void {
    this.jobs.clear()
  }

  /** Every moved head of the PR not already queued; `index` spaces a restart's jobs. */
  scheduleMoved(prKey: string, candidate: GitHubPRRefreshCandidate, index = 0): number {
    for (const head of readPRPendingHeads(this.deps.database.db, prKey)) {
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
    const head = readPRPendingHeads(database.db, job.prKey).find(
      (row) => row.headSha === job.headSha
    )
    const pr = parsePRKey(job.prKey)
    if (!head || !pr || (head.expiresAt !== null && head.expiresAt <= now())) {
      database.transaction((db) => deletePRPendingHead(db, job.prKey, job.headSha))
      this.jobs.delete(prWatchQueueKey(job))
      return null
    }
    try {
      const rollup = await readPRHeadCheckRollup(candidate, pr, job.headSha)
      if (this.deps.apply(job.prKey, job.headSha, rollup)) {
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
    return now() + HEAD_CHECKS_INTERVAL_MS
  }
}
