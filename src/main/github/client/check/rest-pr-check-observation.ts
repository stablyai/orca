import { normalizePRCheckHeadSha } from '../../../../shared/github/checks/pr-check-head'
import type { PRCheckDetail } from '../../../../shared/github/checks/check-types'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { summarizePRCheckRollup } from '../../../../shared/source-control/checks/pr-check-status'
import { acquire, release } from '../../execution/github-operation-slots'
import type { GhExecOptions } from '../github-exec-scope'
import { isPendingApprovalSuiteWithoutRuns } from './pr-check-rollup'
import type { PRChecksObservation } from './pr-checks-last-outcome'
import {
  mapRestCheckRun,
  mapRestCommitStatus,
  getPendingApprovalCheckSuiteName,
  getPendingApprovalCheckSuiteUrl
} from './pr-checks-response-mapping'
import {
  readRestPRCheckRuns,
  readRestPRCommitStatuses,
  readRestPRCheckSuites,
  restPRCheckRollupRows
} from './rest-pr-check-pages'

export async function readRestPRCheckObservation(
  ownerRepo: GitHubApiRepository,
  headSha: string | undefined,
  ghOptions: GhExecOptions,
  noCache?: boolean
): Promise<PRChecksObservation | null> {
  if (!headSha) {
    return null
  }
  await acquire()
  try {
    const runs = await readRestPRCheckRuns(ownerRepo, headSha, ghOptions, Boolean(noCache))
    const checks = runs.map(mapRestCheckRun)
    const checkRunNames = new Set(checks.map((check) => check.name))
    const statuses = await readRestPRCommitStatuses(
      ownerRepo,
      headSha,
      ghOptions,
      Boolean(noCache)
    ).catch((error) => {
      console.warn('getPRChecks REST status fallback failed:', error)
      return null
    })
    if (statuses) {
      checks.push(
        ...statuses
          .map(mapRestCommitStatus)
          .filter(
            (check): check is PRCheckDetail => check !== null && !checkRunNames.has(check.name)
          )
      )
    }
    const suites = await readRestPRCheckSuites(
      ownerRepo,
      headSha,
      ghOptions,
      Boolean(noCache)
    ).catch((error) => {
      console.warn('getPRChecks REST check-suite fallback failed:', error)
      return null
    })
    if (suites) {
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
    }
    const observedHeadSha = normalizePRCheckHeadSha(headSha)
    if (checks.length === 0 && (!statuses || !suites)) {
      return null
    }
    return {
      checks: observedHeadSha ? checks.map((check) => ({ ...check, observedHeadSha })) : checks,
      ...(statuses && suites && observedHeadSha
        ? {
            summary: {
              headSha: observedHeadSha,
              value: summarizePRCheckRollup(restPRCheckRollupRows(runs, statuses, suites))
            }
          }
        : {})
    }
  } catch (err) {
    console.warn('getPRChecks via REST fallback failed, falling back to gh pr checks:', err)
    return null
  } finally {
    release()
  }
}
