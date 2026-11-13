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

/** The provider reads of one resource that are running now, of either intent, including stale or
 *  user-refreshed reads a newer one replaced in the coalescer, and the newest answer one of them
 *  had accepted. It lives until the last of those reads has settled; one answer, no history. */
type PRChecksOverlap = { running: number; latest?: PRChecksRead }
const overlaps = new Map<string, PRChecksOverlap>()

/**
 * The producer of one coalesced checks read; joiners only await it. A timed read and a manual
 * (`noCache`) read of the same resource can run side by side, and a stale or user-refreshed read
 * can replace one still running, so finishing last proves nothing: the answer of the read that
 * started last wins. A read that still owns its key publishes that answer. A replaced read
 * publishes nothing and answers its callers with the newest accepted answer, even one the
 * completed cache has since evicted, or with its successor's while that still runs; its own result
 * is used only when nothing newer was accepted.
 */
export async function producePRChecks(
  resource: string,
  ownsKey: () => boolean,
  readChecks: () => Promise<PRCheckDetail[]>,
  successor: () => Promise<PRChecksRead> | undefined
): Promise<PRChecksRead> {
  readSequence += 1
  const start = { startedAt: Date.now(), sequence: readSequence }
  let overlap = overlaps.get(resource)
  if (!overlap) {
    overlap = { running: 0 }
    overlaps.set(resource, overlap)
  }
  const shared = overlap
  shared.running += 1
  const newer = () =>
    shared.latest && shared.latest.start.sequence > start.sequence ? shared.latest : undefined
  try {
    let own: PRChecksRead | undefined
    let failure: unknown
    try {
      own = { start, checks: await readChecks() }
    } catch (error) {
      failure = error
    }
    if (!ownsKey()) {
      const running = newer() ? undefined : successor()
      if (running) {
        try {
          const replaced = await running
          return newer() ?? replaced
        } catch (error) {
          // A successor that fails leaves this read's own answer as the newest there is.
          failure = own ? failure : error
        }
      }
      const answer = newer() ?? own
      if (!answer) {
        throw failure
      }
      return answer
    }
    const answer = newer() ?? own
    if (!answer) {
      throw failure
    }
    shared.latest = answer
    recordPRChecksRead(resource, answer)
    return answer
  } finally {
    shared.running -= 1
    if (shared.running === 0 && overlaps.get(resource) === shared) {
      overlaps.delete(resource)
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
  return { completed: lastReads.size, running: overlaps.size }
}

export function _resetPacedPRChecksForTests(): void {
  lastReads.clear()
  overlaps.clear()
}
