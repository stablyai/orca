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
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const ghOptions = ghRepoExecOptions(context)
  return {
    localGitOptions,
    ghOptions,
    accountFromProject: context.ghAccountFromProject === true,
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

export function snapshotPRLookupOptions(
  options: GitHubPRBranchLookupOptions
): GitHubPRBranchLookupOptions {
  return {
    ...options,
    ...(options.localGitExecOptions
      ? {
          localGitExecOptions: {
            ...options.localGitExecOptions,
            ...(options.localGitExecOptions.ghAccount
              ? { ghAccount: { ...options.localGitExecOptions.ghAccount } }
              : {})
          }
        }
      : {}),
    ...(options.sharedLinkPaths ? { sharedLinkPaths: [...options.sharedLinkPaths] } : {}),
    ...(options.exactRepository ? { exactRepository: { ...options.exactRepository } } : {})
  }
}

function completeReadInputs(
  repoPath: string,
  branchName: string,
  linkedPRNumber: number | null | undefined,
  fallbackPRNumber: number | null | undefined,
  options: GitHubPRBranchLookupOptions
) {
  return [
    repoPath,
    branchName,
    linkedPRNumber ?? null,
    fallbackPRNumber ?? null,
    options.acceptMergedFallbackPR ?? false,
    options.currentHeadOid ?? null,
    options.checkPageLimit ?? null,
    options.exactRepository ?? null,
    options.includeDerivedData !== false,
    options.sharedLinkPaths ?? null
  ]
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
    scope.generation,
    scope.readScope,
    ...completeReadInputs(repoPath, branchName, linkedPRNumber, fallbackPRNumber, options)
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
  options: GitHubPRBranchLookupOptions,
  accountFromProject: boolean
): string {
  const local = hostedReviewLocalGitOptionArgs(options)[0] ?? {}
  return JSON.stringify([
    repoPath,
    connectionId ?? null,
    local.wslDistro ?? null,
    accountFromProject ? null : (local.ghAccount ?? null)
  ])
}

/** Compares request inputs without discovering accounts; callers fence the prepared scope separately. */
export function exactRequestMatcher(
  request: Parameters<typeof prBranchReadKeys>,
  accountFromProject = false
): (other: Parameters<typeof prBranchReadKeys>) => boolean {
  const identity = ([repoPath, branch, linked, connectionId, fallback, options]: Parameters<
    typeof prBranchReadKeys
  >) =>
    JSON.stringify([
      scopeInputs(repoPath, connectionId, options, accountFromProject),
      ...completeReadInputs(
        repoPath,
        branch.replace(/^refs\/heads\//, ''),
        linked,
        fallback,
        options
      )
    ])
  const expected = identity(request)
  return (other) => identity(other) === expected
}

export function cachedPRBranchOutcome(
  ...request: Parameters<typeof prBranchReadKeys>
): ReturnType<typeof readTimedPROutcome> {
  return readTimedPROutcome(...prBranchReadKeys(...request))
}
