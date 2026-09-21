import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { extractExecError } from '../../../git/exec-error'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mapCheckStatus, mapCheckConclusion } from '../../mappers'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import {
  PR_CHECKS_ROLLUP_QUERY,
  type GraphQLPRChecksResponse,
  type RestCheckRun,
  type RestCommitStatus,
  type RestCheckSuite
} from './pr-checks-graphql-query'
import {
  mapRestCheckRun,
  mapRestCommitStatus,
  mapGraphQLPRChecksResponse,
  getPendingApprovalCheckSuiteName,
  getPendingApprovalCheckSuiteUrl
} from './pr-checks-response-mapping'
import { parseActionsRunId } from './check-detail-field-mapping'
export async function getPRChecksViaRestFallback(
  ownerRepo: GitHubApiRepository,
  headSha: string | undefined,
  ghOptions: GhExecOptions,
  noCache?: boolean
): Promise<PRCheckDetail[] | null> {
  if (!headSha) {
    return null
  }
  try {
    await assertRateLimitBudget('core', ownerRepo, ghOptions)
  } catch (err) {
    console.warn('getPRChecks skipped REST fallback, falling back to gh pr checks:', err)
    return null
  }

  await acquire()
  try {
    const cacheArgs = noCache ? [] : ['--cache', '60s']
    const encodedHeadSha = encodeURIComponent(headSha)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        ...cacheArgs,
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodedHeadSha}/check-runs?per_page=100`
      ],
      ghOptions
    )
    noteRepositoryRateLimitSpend(ownerRepo, 'core', 1, ghOptions)
    const checkRunData = JSON.parse(stdout) as {
      check_runs?: RestCheckRun[]
    }
    const checkRuns = (checkRunData.check_runs ?? []).map(mapRestCheckRun)
    const checkRunNames = new Set(checkRuns.map((check) => check.name))

    let legacyStatuses: PRCheckDetail[] = []
    try {
      const statusResult = await ghExecFileAsync(
        [
          'api',
          ...cacheArgs,
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodedHeadSha}/status?per_page=100`
        ],
        ghOptions
      )
      noteRepositoryRateLimitSpend(ownerRepo, 'core', 1, ghOptions)
      const statusData = JSON.parse(statusResult.stdout) as {
        statuses?: RestCommitStatus[]
      }
      legacyStatuses = (statusData.statuses ?? [])
        .map(mapRestCommitStatus)
        .filter((check): check is PRCheckDetail => check !== null && !checkRunNames.has(check.name))
    } catch (err) {
      // Why: REST fallback is already degraded; keep the richer check-run rows if legacy-status enrichment fails.
      console.warn('getPRChecks REST status fallback failed:', err)
    }

    let pendingApprovalChecks: PRCheckDetail[] = []
    try {
      const suitesResult = await ghExecFileAsync(
        [
          'api',
          ...cacheArgs,
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodedHeadSha}/check-suites?per_page=100`
        ],
        ghOptions
      )
      noteRepositoryRateLimitSpend(ownerRepo, 'core', 1, ghOptions)
      const suitesData = JSON.parse(suitesResult.stdout) as {
        check_suites?: RestCheckSuite[]
      }
      pendingApprovalChecks = (suitesData.check_suites ?? [])
        .filter((suite) => suite.conclusion?.toLowerCase() === 'action_required')
        .map((suite, index) => ({
          name: getPendingApprovalCheckSuiteName(suite, headSha, index),
          status: 'completed' as const,
          conclusion: 'action_required' as const,
          url: getPendingApprovalCheckSuiteUrl(ownerRepo, headSha, suite.id)
        }))
    } catch (err) {
      console.warn('getPRChecks REST check-suite fallback failed:', err)
    }

    const checks = [...checkRuns, ...legacyStatuses, ...pendingApprovalChecks]
    return checks.length > 0 ? checks : null
  } catch (err) {
    console.warn('getPRChecks via REST fallback failed, falling back to gh pr checks:', err)
    return null
  } finally {
    release()
  }
}

/**
 * Get detailed check statuses for a PR.
 * Uses GitHub's combined GraphQL rollup so check runs and legacy commit statuses
 * arrive in one cached request; suite-only approval blockers are included too.
 */
export async function getPRChecks(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: GitHubApiRepository | null,
  options?: { noCache?: boolean },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  void headSha
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
      const fallbackArgs = ['pr', 'checks', String(prNumber), '--json', 'name,state,link']
      if (ownerRepo) {
        fallbackArgs.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
      }
      const { stdout } = await ghExecFileAsync(fallbackArgs, ghOptions).catch((err: unknown) => {
        const { stderr } = extractExecError(err)
        // Why: `gh pr checks` exits non-zero when a PR has no check runs yet; treat that as empty, not a load failure.
        if (stderr.toLowerCase().includes('no checks reported')) {
          return { stdout: '[]', stderr }
        }
        throw err
      })
      noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
      const data = JSON.parse(stdout) as { name: string; state: string; link: string }[]
      return data.map((d) => ({
        name: d.name,
        status: mapCheckStatus(d.state),
        conclusion: mapCheckConclusion(d.state),
        url: d.link || null,
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
        // Why: --cache 60s saves rate-limit budget during polling; explicit refresh skips it for fresh data.
        const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            'graphql',
            ...cacheArgs,
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
        // Why: fall back to older `gh pr checks` when GitHub's richer rollup query is unavailable.
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
