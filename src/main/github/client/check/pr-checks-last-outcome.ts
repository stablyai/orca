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

function recordPRChecksRead(key: string, read: PRChecksRead): void {
  const existing = lastReads.get(key)
  if (existing && existing.start.sequence > read.start.sequence) {
    return
  }
  lastReads.delete(key)
  lastReads.set(key, read)
  while (lastReads.size > MAX_ENTRIES) {
    lastReads.delete(lastReads.keys().next().value!)
  }
}

export const prChecksProbeKey = (resource: string, noCache: boolean): string =>
  JSON.stringify([resource, noCache])

/** A provider read of one resource while it runs: when it started, and a newer answer the other
 *  intent's read finished meanwhile. Kept only while the read runs, under its probe key. */
type PRChecksTask = { start: PRChecksReadStart; newer?: PRChecksRead }
const runningTasks = new Map<string, PRChecksTask>()

/**
 * The producer of one coalesced checks read; joiners only await it. A timed read and a manual
 * (`noCache`) read of the same resource run side by side, so whichever finishes last must not win
 * just by finishing: an answer from a read that started later is handed to the older one while it
 * still runs, and the older one then answers with it and never publishes its own. A read replaced
 * as stale publishes nothing and answers with its replacement.
 */
export async function producePRChecks(
  resource: string,
  noCache: boolean,
  ownsKey: () => boolean,
  readChecks: () => Promise<PRCheckDetail[]>,
  replacement: () => Promise<PRChecksRead> | undefined
): Promise<PRChecksRead> {
  const key = prChecksProbeKey(resource, noCache)
  readSequence += 1
  const task: PRChecksTask = { start: { startedAt: Date.now(), sequence: readSequence } }
  runningTasks.set(key, task)
  try {
    let read: PRChecksRead | undefined
    let failure: unknown
    try {
      read = { start: task.start, checks: await readChecks() }
    } catch (error) {
      failure = error
    }
    const replaced = ownsKey() ? undefined : replacement()
    if (replaced) {
      return await replaced
    }
    read ??= task.newer
    if (!read) {
      throw failure
    }
    if (!ownsKey()) {
      return read
    }
    const answer = task.newer ?? read
    const other = runningTasks.get(prChecksProbeKey(resource, !noCache))
    if (
      other &&
      other.start.sequence < answer.start.sequence &&
      (other.newer?.start.sequence ?? 0) < answer.start.sequence
    ) {
      other.newer = answer
    }
    recordPRChecksRead(resource, answer)
    return answer
  } finally {
    if (runningTasks.get(key) === task) {
      runningTasks.delete(key)
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

export function _prChecksResultCountForTests(): { completed: number; running: number } {
  return { completed: lastReads.size, running: runningTasks.size }
}

export function _resetPacedPRChecksForTests(): void {
  lastReads.clear()
  runningTasks.clear()
}
