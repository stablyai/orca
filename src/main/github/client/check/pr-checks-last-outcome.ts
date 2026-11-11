import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  reviewRefreshIntervalMs,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import { ghRepoExecOptions, githubRepoContext, type LocalGitExecOptions } from '../../gh-utils'
import { githubPRStackExecutionScope } from '../github-exec-scope'

const MAX_ENTRIES = 256

type PRChecksReadStart = { startedAt: number; sequence: number }
type PRChecksLastRead = { start: PRChecksReadStart; checks: PRCheckDetail[] }

const lastReads = new Map<string, PRChecksLastRead>()
let readSequence = 0

/** The same identity the provider read itself is coalesced and invalidated by: where the read runs
 *  (SSH connection or local/WSL), the repository's review generation, and the resolved read scope
 *  (gh account, cwd, environment). A changed account or a bumped generation is a different key, so
 *  checks read under the previous credential are never answered to the current one. */
export function pacedPRChecksKey(
  repoPath: string,
  connectionId: string | null | undefined,
  prNumber: number,
  headSha: string | undefined,
  prRepo: GitHubOwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  return JSON.stringify([
    githubPRStackExecutionScope(connectionId, localGitOptions),
    repoPath,
    scopeGeneration(hostedReviewRepoScope(repoPath, getRepoExecutionHostId({ connectionId }))),
    githubReadExecutionScope(ghOptions),
    prNumber,
    headSha ?? null,
    prRepo ? [prRepo.host ?? null, prRepo.owner, prRepo.repo] : null
  ])
}

export function startPRChecksRead(): PRChecksReadStart {
  readSequence += 1
  return { startedAt: Date.now(), sequence: readSequence }
}

export function recordPRChecksRead(
  key: string,
  start: PRChecksReadStart,
  checks: PRCheckDetail[]
): void {
  const existing = lastReads.get(key)
  if (existing && existing.start.sequence > start.sequence) {
    return
  }
  lastReads.delete(key)
  lastReads.set(key, { start, checks })
  for (const oldestKey of lastReads.keys()) {
    if (lastReads.size <= MAX_ENTRIES) {
      break
    }
    lastReads.delete(oldestKey)
  }
}

/** With a slower host cadence, a client's timed checks read reuses this host's last full read of the
 *  same PR head until the host's own selected interval has passed ("off": until a foreground,
 *  refresh or changed-state read). A different head is a different key, so a push always reads. */
export function readPacedPRChecks(
  key: string,
  cadence: PRAutoRefreshCadence
): PRCheckDetail[] | null {
  if (cadence === 'default') {
    return null
  }
  const entry = lastReads.get(key)
  if (!entry) {
    return null
  }
  // Checks are only polled while they may still move, so pace them like a selected open PR.
  const interval = reviewRefreshIntervalMs(
    { state: 'open', checksStatus: 'pending', hasReview: true, selected: true },
    cadence
  )
  if (interval !== null && Date.now() - entry.start.startedAt >= interval) {
    return null
  }
  return entry.checks
}

export function _resetPacedPRChecksForTests(): void {
  lastReads.clear()
}
