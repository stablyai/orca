import { normalizePRCheckHeadSha } from '../../../../shared/github/checks/pr-check-head'
import { getPRAutoRefreshCadence } from '../../../../shared/source-control/hosted-review/review-refresh-policy'
import {
  withGitHubRepoExecution,
  type LocalGitExecOptions
} from '../../repositories/github-repository-identity'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import type { PRCheckDetail } from '../../../../shared/github/checks/check-types'
import { summarizePRCheckRollup } from '../../../../shared/source-control/checks/pr-check-status'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/github/work-items/work-item-ssh-error'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { acquire, release } from '../../execution/github-operation-slots'

import { extractExecError } from '../../../git/command-runner/process-capture/exec-error'
import { resolveGitHubRepoExecution } from '../../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { mapCheckStatus, mapCheckConclusion } from '../../api/github-read-response'
import { noteRepositoryRateLimitSpend } from '../../api/rate-limit'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import { prCheckRollupRows, readGraphQLPRCheckPages } from './pr-check-rollup'
import { mapGraphQLPRCheckPages } from './pr-checks-response-mapping'
import { parseActionsRunId } from './check-detail-field-mapping'
import { checkRunTimes } from '../../../../shared/source-control/checks/pr-check-time'
import {
  latestPRChecks,
  prChecksProbeKey,
  prChecksResourceKey,
  producePRChecks,
  readPacedPRChecks,
  type PRChecksObservation,
  type PRChecksRead
} from './pr-checks-last-outcome'
import { readRestPRCheckObservation } from './rest-pr-check-observation'

/** Read the combined GraphQL rollup, including legacy statuses and suite-only approval blockers. */
async function readPRChecks(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: GitHubApiRepository | null,
  options?: { noCache?: boolean },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRChecksObservation> {
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
        const pages = await readGraphQLPRCheckPages(ownerRepo, prNumber, ghOptions, {
          detailed: true
        })
        const observedHeadSha = normalizePRCheckHeadSha(pages.headSha)
        return {
          checks: mapGraphQLPRCheckPages(ownerRepo, pages),
          ...(observedHeadSha
            ? {
                summary: {
                  headSha: observedHeadSha,
                  value: summarizePRCheckRollup(prCheckRollupRows(pages))
                }
              }
            : {})
        }
      } catch (err) {
        // Older CLI/API schemas may require the legacy gh pr checks path.
        console.warn('getPRChecks via GraphQL rollup failed, falling back to gh pr checks:', err)
      } finally {
        release()
      }
    }
    const restChecks = await readRestPRCheckObservation(
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
    return { checks: await fallbackToPRChecks() }
  } catch (err) {
    console.warn('getPRChecks failed:', err)
    throw err
  }
}

const checksReads: CoalescedProbes<PRChecksRead> = new Map()

/** `timed`: a client's timer tick, which this host may answer from its last read at its PR
 *  auto-refresh cadence. A manual read (`userRefresh`, `noCache`) always reaches the provider. */
type PRChecksReadOptions = { noCache?: boolean; userRefresh?: boolean; timed?: boolean }

export async function getPRChecks(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: GitHubApiRepository | null,
  options?: PRChecksReadOptions,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  const { checks } = await getPRChecksObservation(
    repoPath,
    prNumber,
    headSha,
    prRepo,
    options,
    connectionId,
    localGitOptions
  )
  return checks
}

export function getPRChecksObservation(
  repoPath: string,
  prNumber: number,
  headSha?: string,
  prRepo?: GitHubApiRepository | null,
  options?: PRChecksReadOptions,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRChecksObservation> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    const resource = prChecksResourceKey(
      repoPath,
      connectionId,
      prNumber,
      headSha,
      prRepo ?? null,
      localGitOptions
    )
    if (options?.timed && !options.noCache && !options.userRefresh) {
      const paced = readPacedPRChecks(resource, getPRAutoRefreshCadence())
      if (paced) {
        return paced
      }
    }
    // The resource key carries the review generation, so a read after a PR mutation never joins
    // one that started before it; the producer records its own result at its own start order.
    const probeKey = prChecksProbeKey(resource, Boolean(options?.noCache))
    const read = await runCoalescedProbe(
      checksReads,
      probeKey,
      (ownsKey) =>
        producePRChecks(
          resource,
          ownsKey,
          () =>
            readPRChecks(
              repoPath,
              prNumber,
              headSha,
              prRepo,
              options,
              connectionId,
              localGitOptions
            ),
          () => checksReads.get(probeKey)?.promise
        ),
      undefined,
      { userRefresh: options?.userRefresh === true }
    )
    return latestPRChecks(resource, read)
  })
}
