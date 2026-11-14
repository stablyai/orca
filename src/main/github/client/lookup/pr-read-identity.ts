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

export function cachedPRBranchOutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber: number | null,
  connectionId: string | null,
  fallbackPRNumber: number | null,
  options: GitHubPRBranchLookupOptions
): ReturnType<typeof readTimedPROutcome> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  const scope = prLookupScope(repoPath, connectionId, options)
  return readTimedPROutcome(
    lastOutcomeKey(repoPath, branchName, scope),
    completeReadKey(repoPath, branchName, linkedPRNumber, fallbackPRNumber, options, scope)
  )
}
