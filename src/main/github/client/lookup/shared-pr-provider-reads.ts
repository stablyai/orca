import { runCoalescedProbe, type CoalescedProbes } from '../../../git/remotes/coalesced-probe'
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
  executionScope: string
): unknown[] {
  const { cwd: _cwd, signal: _signal, ...account } = options
  return [
    executionScope,
    githubReadExecutionScope(account),
    (repository.host ?? 'github.com').toLowerCase(),
    repository.owner.toLowerCase(),
    repository.repo.toLowerCase(),
    number
  ]
}

export function readSharedPullRequestSidebarQuery(
  repository: GitHubApiRepository,
  number: number,
  options: GhExecOptions,
  executionScope: string
): Promise<PullRequestLookupData | null | undefined> {
  return runCoalescedProbe(
    sidebarReads,
    JSON.stringify(sharedPRKey(repository, number, options, executionScope)),
    () => readPullRequestSidebarQuery(repository, number, options)
  )
}

export function readSharedPRCheckObservation(
  repository: GitHubApiRepository,
  number: number,
  headSha: string | undefined,
  options: GhExecOptions,
  executionScope: string
): Promise<unknown[] | undefined> {
  return runCoalescedProbe(
    checkReads,
    JSON.stringify([...sharedPRKey(repository, number, options, executionScope), headSha ?? null]),
    () => readCompletePRCheckObservation(repository, number, headSha, options)
  )
}
