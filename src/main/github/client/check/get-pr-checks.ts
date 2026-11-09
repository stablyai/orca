import { normalizePRCheckHeadSha } from '../../../../shared/github/pr-check-head'
import {
  withGitHubRepoExecution,
  githubRepoContext,
  ghRepoExecOptions
} from '../../github-repository-identity'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/github/work-item-ssh-error'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { extractExecError } from '../../../git/exec-error'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mapCheckStatus, mapCheckConclusion } from '../../mappers'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import { PR_CHECKS_ROLLUP_QUERY, type GraphQLPRChecksResponse } from './pr-checks-graphql-query'
import {
  mapRestCheckRun,
  mapRestCommitStatus,
  mapGraphQLPRChecksResponse,
  getPendingApprovalCheckSuiteName,
  getPendingApprovalCheckSuiteUrl,
  isPendingApprovalSuiteWithoutRuns
} from './pr-checks-response-mapping'
import { parseActionsRunId } from './check-detail-field-mapping'
import { checkRunTimes } from '../../../../shared/source-control/checks/pr-check-time'
import {
  readRestPRCheckRuns,
  readRestPRCommitStatuses,
  readRestPRCheckSuites
} from './rest-pr-check-pages'
export async function getPRChecksViaRestFallback(
  ownerRepo: GitHubApiRepository,
  headSha: string | undefined,
  ghOptions: GhExecOptions,
  noCache?: boolean
): Promise<PRCheckDetail[] | null> {
  if (!headSha) {
    return null
  }
  await acquire()
  try {
    const runs = await readRestPRCheckRuns(ownerRepo, headSha, ghOptions, Boolean(noCache))
    const checks = runs.map((run) =>
      mapRestCheckRun({
        ...run,
        name: run.name ?? '',
        html_url: run.html_url ?? '',
        details_url: run.details_url ?? null
      })
    )
    const checkRunNames = new Set(checks.map((check) => check.name))
    try {
      const statuses = await readRestPRCommitStatuses(
        ownerRepo,
        headSha,
        ghOptions,
        Boolean(noCache)
      )
      checks.push(
        ...statuses
          .map(mapRestCommitStatus)
          .filter(
            (check): check is PRCheckDetail => check !== null && !checkRunNames.has(check.name)
          )
      )
    } catch (err) {
      // Detail rows remain useful when best-effort enrichment fails.
      console.warn('getPRChecks REST status fallback failed:', err)
    }
    try {
      const suites = await readRestPRCheckSuites(ownerRepo, headSha, ghOptions, Boolean(noCache))
      const represented = new Set(
        runs.flatMap((run) => (run.check_suite ? [run.check_suite.id] : []))
      )
      checks.push(
        ...suites
          .filter((suite) =>
            isPendingApprovalSuiteWithoutRuns(
              suite.conclusion,
              suite.id !== undefined && represented.has(suite.id)
            )
          )
          .map((suite, index) => ({
            name: getPendingApprovalCheckSuiteName(suite, headSha, index),
            status: 'completed' as const,
            conclusion: 'action_required' as const,
            url: getPendingApprovalCheckSuiteUrl(ownerRepo, headSha, suite.id)
          }))
      )
    } catch (err) {
      console.warn('getPRChecks REST check-suite fallback failed:', err)
    }
    const observedHeadSha = normalizePRCheckHeadSha(headSha)
    return checks.length > 0
      ? checks.map((check) => (observedHeadSha ? { ...check, observedHeadSha } : check))
      : null
  } catch (err) {
    console.warn('getPRChecks via REST fallback failed, falling back to gh pr checks:', err)
    return null
  } finally {
    release()
  }
}

/** Read the combined GraphQL rollup, including legacy statuses and suite-only approval blockers. */
async function readPRChecks(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: GitHubApiRepository | null,
  options?: { noCache?: boolean },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (connectionId && !ownerRepo) {
    throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
  }
  const fallbackToPRChecks = async (): Promise<PRCheckDetail[]> => {
    await assertRateLimitBudget('graphql', ownerRepo, ghOptions)
    await acquire()
    try {
      const readFallback = (fields: string) => {
        const fallbackArgs = ['pr', 'checks', String(prNumber), '--json', fields]
        if (ownerRepo) {
          fallbackArgs.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
        }
        return ghExecFileAsync(fallbackArgs, ghOptions).catch((err: unknown) => {
          const { stderr } = extractExecError(err)
          // gh pr checks signals an empty run set with nonzero exit.
          if (stderr.toLowerCase().includes('no checks reported')) {
            return { stdout: '[]', stderr }
          }
          throw err
        })
      }
      const { stdout } = await readFallback('name,state,link,startedAt,completedAt').catch(
        (err: unknown) => {
          // Older gh builds reject unknown --json fields; their rows simply have no times.
          if (!extractExecError(err).stderr.toLowerCase().includes('unknown json field')) {
            throw err
          }
          return readFallback('name,state,link')
        }
      )
      noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
      const data: {
        name: string
        state: string
        link: string
        startedAt?: string
        completedAt?: string
      }[] = JSON.parse(stdout)
      return data.map((d) => ({
        name: d.name,
        status: mapCheckStatus(d.state),
        conclusion: mapCheckConclusion(d.state),
        url: d.link || null,
        ...checkRunTimes(d.startedAt, d.completedAt),
        workflowRunId: parseActionsRunId(d.link)
      }))
    } finally {
      release()
    }
  }

  if (ownerRepo) {
    let canUseGraphQLRollup = true
    try {
      await assertRateLimitBudget('graphql', ownerRepo, ghOptions)
    } catch (err) {
      canUseGraphQLRollup = false
      console.warn('getPRChecks skipped GraphQL rollup, falling back to gh pr checks:', err)
    }
    if (canUseGraphQLRollup) {
      await acquire()
      try {
        // No gh disk cache: its key ignores the PR head, so it served the previous head's checks after a push, and it never evicts.
        // Orca's own head-keyed checks cache and read coalescing bound the request volume.
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            'graphql',
            '-f',
            `owner=${ownerRepo.owner}`,
            '-f',
            `repo=${ownerRepo.repo}`,
            '-F',
            `pr=${prNumber}`,
            '-f',
            `query=${PR_CHECKS_ROLLUP_QUERY}`
          ],
          ghOptions
        )
        noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
        const checks = mapGraphQLPRChecksResponse(
          ownerRepo,
          JSON.parse(stdout) as GraphQLPRChecksResponse
        )
        if (checks !== null) {
          return checks
        }
      } catch (err) {
        // Older CLI/API schemas may require the legacy gh pr checks path.
        console.warn('getPRChecks via GraphQL rollup failed, falling back to gh pr checks:', err)
      } finally {
        release()
      }
    }
    const restChecks = await getPRChecksViaRestFallback(
      ownerRepo,
      headSha,
      ghOptions,
      options?.noCache
    )
    if (restChecks !== null) {
      return restChecks
    }
  }

  try {
    return await fallbackToPRChecks()
  } catch (err) {
    console.warn('getPRChecks failed:', err)
    throw err
  }
}

const checksReads: CoalescedProbes<PRCheckDetail[]> = new Map()

export function getPRChecks(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: GitHubApiRepository | null,
  options?: { noCache?: boolean; userRefresh?: boolean },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    const key = JSON.stringify([
      repoPath,
      prNumber,
      headSha ?? null,
      prRepo ?? null,
      Boolean(options?.noCache),
      connectionId ?? null,
      githubReadExecutionScope(
        ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
      )
    ])
    return runCoalescedProbe(
      checksReads,
      key,
      () =>
        readPRChecks(repoPath, prNumber, headSha, prRepo, options, connectionId, localGitOptions),
      undefined,
      { userRefresh: options?.userRefresh === true }
    )
  })
}
