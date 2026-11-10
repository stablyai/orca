import { withGitHubRepoExecution } from '../../github-repository-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  hostedReviewRepoScope,
  scopeGeneration
} from '../../../source-control/hosted-review-scope-generations'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import { acquire, release, ghRepoExecOptions, githubRepoContext } from '../../gh-utils'
import { hostedReviewLocalGitOptionArgs, githubPRStackExecutionScope } from './../github-exec-scope'
import type { GitHubPRBranchLookupOptions } from './pull-request-lookup-data'
import { prRefreshUpstreamError } from './../gh-error-predicates'
import { resolvePRForBranchOutcome } from './branch-lookup-resolution'
import {
  readPacedPROutcome,
  readRecentOpenPROutcome,
  recordPRLastOutcome,
  startPRLookup
} from './pr-last-outcome'
import type { PRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
const reads: CoalescedProbes<PRRefreshOutcome> = new Map()

function prLookupScope(
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

function lastOutcomeKey(
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

/** A phone read may take the last lookup's open PR; it was already observed when it was looked up. */
export async function readRecentPhonePROutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber: number | null,
  connectionId: string | null,
  fallbackPRNumber: number | null,
  options: GitHubPRBranchLookupOptions
): Promise<PRRefreshOutcome | null> {
  if (options.userRefresh === true) {
    return null
  }
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    hostedReviewLocalGitOptionArgs(options)[0] ?? {},
    async () =>
      readRecentOpenPROutcome(
        lastOutcomeKey(
          repoPath,
          branch.replace(/^refs\/heads\//, ''),
          prLookupScope(repoPath, connectionId, options)
        ),
        {
          linkedPRNumber,
          fallbackPRNumber: linkedPRNumber === null ? fallbackPRNumber : null,
          currentHeadOid: options.currentHeadOid ?? null
        }
      )
  )
}

/** A paired client's timed read on a host with a slower cadence: the last answer, while still due. */
export async function readPacedClientPROutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber: number | null,
  connectionId: string | null,
  fallbackPRNumber: number | null,
  options: GitHubPRBranchLookupOptions,
  cadence: PRAutoRefreshCadence
): Promise<PRRefreshOutcome | null> {
  if (cadence === 'default' || options.userRefresh === true) {
    return null
  }
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    hostedReviewLocalGitOptionArgs(options)[0] ?? {},
    async () =>
      readPacedPROutcome(
        lastOutcomeKey(
          repoPath,
          branch.replace(/^refs\/heads\//, ''),
          prLookupScope(repoPath, connectionId, options)
        ),
        {
          linkedPRNumber,
          fallbackPRNumber: linkedPRNumber === null ? fallbackPRNumber : null,
          currentHeadOid: options.currentHeadOid ?? null
        },
        cadence
      )
  )
}

export async function getPRForBranchOutcome(
  repoPath: string,
  branch: string,
  linkedPRNumber?: number | null,
  connectionId?: string | null,
  fallbackPRNumber?: number | null,
  options: GitHubPRBranchLookupOptions = {}
): Promise<PRRefreshOutcome> {
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    hostedReviewLocalGitOptionArgs(options)[0] ?? {},
    async (): Promise<PRRefreshOutcome> => {
      const branchName = branch.replace(/^refs\/heads\//, '')
      // Detached HEAD cannot discover by branch, but explicit PR numbers remain safe.
      if (
        !branchName &&
        typeof linkedPRNumber !== 'number' &&
        typeof fallbackPRNumber !== 'number'
      ) {
        return { kind: 'no-pr', fetchedAt: Date.now() }
      }
      const scope = prLookupScope(repoPath, connectionId, options)
      const { localGitOptions, ghOptions, executionScope } = scope
      const key = JSON.stringify([
        executionScope,
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
        scope.readScope
      ])
      return runCoalescedProbe(
        reads,
        key,
        async () => {
          await acquire()
          const start = startPRLookup()
          let outcome: PRRefreshOutcome
          try {
            outcome = await resolvePRForBranchOutcome({
              repoPath,
              branchName,
              linkedPRNumber,
              connectionId,
              fallbackPRNumber,
              options,
              localGitOptions,
              ghOptions,
              executionScope
            })
          } catch (err) {
            outcome = prRefreshUpstreamError(err)
          } finally {
            release()
          }
          const narrowed =
            options.checkPageLimit !== undefined ||
            options.exactRepository ||
            options.includeDerivedData === false
          recordPRLastOutcome(lastOutcomeKey(repoPath, branchName, scope), {
            start,
            linkedPRNumber: linkedPRNumber ?? null,
            fallbackPRNumber: fallbackPRNumber ?? null,
            headOid: options.currentHeadOid ?? null,
            outcome: narrowed ? null : outcome
          })
          return outcome
        },
        2 * 60_000,
        options
      )
    }
  )
}
