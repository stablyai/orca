import {
  PROBE_COALESCE_STALE_MS,
  runCoalescedProbe,
  type CoalescedProbes
} from '../../../git/remotes/coalesced-probe'
import type { GitHubApiRepository } from '../../github-api-repository'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import { readCompletePRCheckObservation } from '../check/complete-pr-check-observation'
import type { GhExecOptions } from '../github-exec-scope'
import type { PullRequestLookupData } from './pull-request-lookup-data'
import { readPullRequestSidebarQuery } from './pull-request-sidebar-query'

// Only provider requests are shared: every checkout still derives containment, divergence and
// hiding from its own HEAD over the shared response.
const sidebarReads: CoalescedProbes<PullRequestLookupData | null | undefined> = new Map()
const checkReads: CoalescedProbes<unknown[] | undefined> = new Map()

/** One PR as one host account sees it, whichever checkout or surface asks. */
function sharedPRKey(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  executionScope: string,
  pageLimit: number | undefined
): unknown[] {
  const { cwd: _cwd, signal: _signal, ...account } = options
  return [
    executionScope,
    githubReadExecutionScope(account),
    (repository.host ?? 'github.com').toLowerCase(),
    repository.owner.toLowerCase(),
    repository.repo.toLowerCase(),
    number,
    // A bounded read may be incomplete, so it never serves an unbounded caller.
    pageLimit ?? null
  ]
}

/** How a lookup reads its provider requests: a CI-line watch's page bound, a user's refresh. */
export type PRProviderReadOptions = { checkPageLimit?: number; userRefresh?: boolean }

/** A bounded read may join an unbounded one in flight; never the reverse. A user's refresh joins
 *  nothing begun before the click: it starts the read later callers share. */
function sharedRead<T>(
  probes: CoalescedProbes<T>,
  key: (pageLimit: number | undefined) => string,
  reads: PRProviderReadOptions,
  read: () => Promise<T>
): Promise<T> {
  const { checkPageLimit, userRefresh } = reads
  const unbounded =
    checkPageLimit === undefined || userRefresh ? undefined : probes.get(key(undefined))
  return unbounded && Date.now() - unbounded.startedAt < PROBE_COALESCE_STALE_MS
    ? unbounded.promise
    : runCoalescedProbe(probes, key(checkPageLimit), read, PROBE_COALESCE_STALE_MS, {
        userRefresh: userRefresh === true
      })
}

export function readSharedPullRequestSidebarQuery(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  executionScope: string,
  reads: PRProviderReadOptions = {}
): Promise<PullRequestLookupData | null | undefined> {
  return sharedRead(
    sidebarReads,
    (limit) => JSON.stringify(sharedPRKey(repository, number, options, executionScope, limit)),
    reads,
    () => readPullRequestSidebarQuery(repository, number, options, reads.checkPageLimit)
  )
}

export function readSharedPRCheckObservation(
  repository: GitHubApiRepository,
  number: number,
  headSha: string | undefined,
  options: GhExecOptions,
  executionScope: string,
  reads: PRProviderReadOptions = {}
): Promise<unknown[] | undefined> {
  return sharedRead(
    checkReads,
    (limit) =>
      JSON.stringify([
        ...sharedPRKey(repository, number, options, executionScope, limit),
        headSha ?? null
      ]),
    reads,
    () => readCompletePRCheckObservation(repository, number, headSha, options, reads.checkPageLimit)
  )
}
