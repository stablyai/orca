import type { PRCheckDetail } from '../../../../shared/github/checks/check-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  reviewRefreshIntervalMs,
  type PRAutoRefreshCadence
} from '../../../../shared/review-refresh-policy'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { codeHostReadExecutionScope } from '../../../source-control/code-host-read-execution-scope'
import {
  ghRepoExecOptions,
  githubRepoContext,
  type LocalGitExecOptions
} from '../../repositories/github-repository-identity'
import { githubPRStackExecutionScope } from '../github-exec-scope'

const MAX_ENTRIES = 256

type PRChecksReadStart = { startedAt: number; sequence: number }
export type PRChecksRead = { start: PRChecksReadStart; checks: PRCheckDetail[] }

const lastReads = new Map<string, PRChecksRead>()
let readSequence = 0

/** One PR head's checks as a resource: where the read runs (SSH connection or local/WSL), the
 *  repository's review generation, and the resolved read scope (gh account, cwd, environment). A
 *  changed account or a bumped generation is a different resource, so checks read under the
 *  previous credential or before a PR mutation are never answered to the current one. */
export function prChecksResourceKey(
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
    codeHostReadExecutionScope(ghOptions),
    prNumber,
    headSha ?? null,
    prRepo ? [prRepo.host ?? null, prRepo.owner, prRepo.repo] : null
  ])
}

/** Called where a provider read actually starts, so a later start is always the newer answer. */
export function startPRChecksRead(): PRChecksReadStart {
  readSequence += 1
  return { startedAt: Date.now(), sequence: readSequence }
}

/** `reading(key)`: a producer for that resource is still running. Its newest completed answer is
 *  then the only proof the running one is older, so pressure evicts other answers first; the bound
 *  is exceeded only by resources being read right now. */
export function recordPRChecksRead(
  key: string,
  read: PRChecksRead,
  reading: (key: string) => boolean
): void {
  const existing = lastReads.get(key)
  if (existing && existing.start.sequence > read.start.sequence) {
    return
  }
  lastReads.delete(key)
  lastReads.set(key, read)
  for (const oldest of lastReads.keys()) {
    if (lastReads.size <= MAX_ENTRIES) {
      break
    }
    if (oldest !== key && !reading(oldest)) {
      lastReads.delete(oldest)
    }
  }
}

/** What a caller of `read` receives: a read that started later and already settled is newer. */
export function latestPRChecks(key: string, read: PRChecksRead): PRCheckDetail[] {
  const latest = lastReads.get(key)
  return latest && latest.start.sequence > read.start.sequence ? latest.checks : read.checks
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
