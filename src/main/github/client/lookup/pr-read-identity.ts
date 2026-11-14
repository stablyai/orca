import { ghRepoExecOptions, githubRepoContext } from '../../repositories/github-repository-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { codeHostReadExecutionScope as githubReadExecutionScope } from '../../../source-control/code-host-read-execution-scope'
import { hostedReviewLocalGitOptionArgs, githubPRStackExecutionScope } from '../github-exec-scope'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { readTimedPROutcome } from './pr-last-outcome'

export function prLookupScope(
  repoPath: string,
  connectionId: string | null | undefined,
  options: GitHubPRBranchLookupOptions
) {
  const localGitOptions = hostedReviewLocalGitOptionArgs(options)[0] ?? {}
  const ghOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  return {
    localGitOptions,
    ghOptions,
    executionScope: githubPRStackExecutionScope(connectionId, localGitOptions),
    generation: scopeGeneration(
      hostedReviewRepoScope(repoPath, getRepoExecutionHostId({ connectionId }))
    ),
    readScope: githubReadExecutionScope(ghOptions)
  }
}

export function lastOutcomeKey(
  repoPath: string,
  branchName: string,
  scope: ReturnType<typeof prLookupScope>
): string {
  return JSON.stringify([
    scope.executionScope,
    repoPath,
    scope.generation,
    branchName,
    scope.readScope
  ])
}

export function completeReadKey(
  repoPath: string,
  branchName: string,
  linkedPRNumber: number | null | undefined,
  fallbackPRNumber: number | null | undefined,
  options: GitHubPRBranchLookupOptions,
  scope: ReturnType<typeof prLookupScope>
): string {
  return JSON.stringify([
    scope.executionScope,
    repoPath,
    scope.generation,
    branchName,
    linkedPRNumber ?? null,
    fallbackPRNumber ?? null,
    options.acceptMergedFallbackPR ?? false,
    options.currentHeadOid ?? null,
    options.checkPageLimit ?? null,
    options.exactRepository ?? null,
    options.includeDerivedData !== false,
    options.sharedLinkPaths ?? null,
    scope.readScope
  ])
}

/** The owner and exact keys a read of this request would use now. */
export function prBranchReadKeys(
  repoPath: string,
  branch: string,
  linkedPRNumber: number | null,
  connectionId: string | null,
  fallbackPRNumber: number | null,
  options: GitHubPRBranchLookupOptions
): [owner: string, exact: string] {
  const branchName = branch.replace(/^refs\/heads\//, '')
  const scope = prLookupScope(repoPath, connectionId, options)
  return [
    lastOutcomeKey(repoPath, branchName, scope),
    completeReadKey(repoPath, branchName, linkedPRNumber, fallbackPRNumber, options, scope)
  ]
}

/** Repository and execution inputs that decide a request's scope (the account and generation it
 *  reads with): two requests with the same inputs share one scope sampled at one moment. */
function scopeInputs(
  repoPath: string,
  connectionId: string | null,
  options: GitHubPRBranchLookupOptions
): string {
  const local = hostedReviewLocalGitOptionArgs(options)[0] ?? {}
  return JSON.stringify([
    repoPath,
    connectionId ?? null,
    local.wslDistro ?? null,
    local.ghAccount ?? null
  ])
}

/**
 * Whether other requests are the same exact request as this one, for one synchronous decision:
 * this request's current scope is resolved once, now, and each compared request with the same
 * repository and execution inputs takes its exact key in that scope (the full `completeReadKey`
 * definition), with no scope resolution of its own. A request with other inputs is another
 * request. `exactKey` compares against that key (a prepared read's) instead of this request's.
 * Nothing is kept: a later decision samples its own scope.
 */
export function exactRequestMatcher(
  request: Parameters<typeof prBranchReadKeys>,
  exactKey?: string
): (other: Parameters<typeof prBranchReadKeys>) => boolean {
  const [repoPath, branch, linkedPRNumber, connectionId, fallbackPRNumber, options] = request
  const scope = prLookupScope(repoPath, connectionId, options)
  const inputs = scopeInputs(repoPath, connectionId, options)
  const key =
    exactKey ??
    completeReadKey(
      repoPath,
      branch.replace(/^refs\/heads\//, ''),
      linkedPRNumber,
      fallbackPRNumber,
      options,
      scope
    )
  return ([otherRepo, otherBranch, otherLinked, otherConnection, otherFallback, otherOptions]) =>
    scopeInputs(otherRepo, otherConnection, otherOptions) === inputs &&
    completeReadKey(
      otherRepo,
      otherBranch.replace(/^refs\/heads\//, ''),
      otherLinked,
      otherFallback,
      otherOptions,
      scope
    ) === key
}

export function cachedPRBranchOutcome(
  ...request: Parameters<typeof prBranchReadKeys>
): ReturnType<typeof readTimedPROutcome> {
  return readTimedPROutcome(...prBranchReadKeys(...request))
}
