import type {
  AzureDevOpsPrCheck,
  AzureDevOpsPrFiles,
  AzureDevOpsPrThread
} from '../../../shared/azure-devops/azure-devops-pr-review-types'
import { requestAzureDevOpsJsonAtBase } from '../azure-devops-api-request'
import {
  mapChecks,
  mapFileChanges,
  mapThreads,
  type RawPolicyEvaluation,
  type RawPrStatus,
  type RawThread
} from './pr-review-mappers'
import { pullRequestPath, type PullRequestLocation } from './pr-review-read-client'

const ACTIVITY_TIMEOUT_MS = 15_000
// Policy evaluations never left preview; hosted and Server 2020+ serve this one.
const POLICY_API_VERSION = '6.0-preview.1'

export async function listAzureDevOpsPullRequestThreads(
  location: PullRequestLocation,
  id: number
): Promise<AzureDevOpsPrThread[]> {
  const raw = await requestAzureDevOpsJsonAtBase<{ value?: RawThread[] }>(
    location.collection,
    `${pullRequestPath(location, id)}/threads`,
    { timeoutMs: ACTIVITY_TIMEOUT_MS },
    true
  )
  return mapThreads(raw?.value)
}

export async function listAzureDevOpsPullRequestChecks(
  location: PullRequestLocation,
  id: number
): Promise<AzureDevOpsPrCheck[]> {
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${location.projectId}/${id}`
  const [evaluations, statuses] = await Promise.all([
    requestAzureDevOpsJsonAtBase<{ value?: RawPolicyEvaluation[] }>(
      location.collection,
      `/${encodeURIComponent(location.projectId)}/_apis/policy/evaluations`,
      {
        searchParams: { artifactId, 'api-version': POLICY_API_VERSION },
        timeoutMs: ACTIVITY_TIMEOUT_MS
      },
      true
    ),
    requestAzureDevOpsJsonAtBase<{ value?: RawPrStatus[] }>(
      location.collection,
      `${pullRequestPath(location, id)}/statuses`,
      { timeoutMs: ACTIVITY_TIMEOUT_MS },
      true
    )
  ])
  return mapChecks(
    evaluations?.value,
    statuses?.value,
    (buildId) =>
      `${location.collection}/${encodeURIComponent(location.projectId)}/_build/results?buildId=${buildId}`
  )
}

type RawIteration = {
  id?: number
  sourceRefCommit?: { commitId?: string | null } | null
  commonRefCommit?: { commitId?: string | null } | null
}

/**
 * Files changed in the latest iteration, measured from `sinceIteration` (0 = the merge base).
 * The commits let a reviewer run `git diff <base> <head>` locally after fetching them.
 */
export async function listAzureDevOpsPullRequestFiles(
  location: PullRequestLocation,
  id: number,
  sinceIteration = 0
): Promise<AzureDevOpsPrFiles> {
  const path = pullRequestPath(location, id)
  const iterations =
    (
      await requestAzureDevOpsJsonAtBase<{ value?: RawIteration[] }>(
        location.collection,
        `${path}/iterations`,
        { timeoutMs: ACTIVITY_TIMEOUT_MS },
        true
      )
    )?.value ?? []
  const latest = iterations.at(-1)
  if (!latest || typeof latest.id !== 'number') {
    return { iteration: 0, comparedTo: 0, baseCommit: null, headCommit: null, files: [] }
  }
  const comparedTo = Math.max(0, Math.min(Math.floor(sinceIteration), latest.id - 1))
  const changes = await requestAzureDevOpsJsonAtBase<{
    changeEntries?: Parameters<typeof mapFileChanges>[0]
  }>(
    location.collection,
    `${path}/iterations/${latest.id}/changes`,
    {
      searchParams: { $top: '2000', ...(comparedTo > 0 ? { $compareTo: String(comparedTo) } : {}) },
      timeoutMs: ACTIVITY_TIMEOUT_MS
    },
    true
  )
  const base =
    comparedTo > 0
      ? iterations.find((iteration) => iteration.id === comparedTo)?.sourceRefCommit
      : latest.commonRefCommit
  return {
    iteration: latest.id,
    comparedTo,
    baseCommit: base?.commitId ?? null,
    headCommit: latest.sourceRefCommit?.commitId ?? null,
    files: mapFileChanges(changes?.changeEntries)
  }
}
