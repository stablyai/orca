import { normalizePRCheckHeadSha } from '../../../../shared/github/checks/pr-check-head'
import type { PRCheckDetail } from '../../../../shared/github/checks/check-types'
import { githubRepositoryWebHost } from '../../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import {
  mapCheckRunRESTStatus,
  mapCheckRunRESTConclusion,
  mapCommitStatusRESTStatus,
  mapCommitStatusRESTConclusion
} from '../../api/github-read-response'
import {
  isPendingApprovalSuiteWithoutRuns,
  type PRCheckContext,
  type PRCheckPages,
  type PRCheckSuite
} from './pr-check-rollup'
import type { RestCheckRun, RestCommitStatus } from './rest-pr-check-pages'
import { nullableString, nullableNumber, parseActionsRunId } from './check-detail-field-mapping'
import {
  checkRunTimes,
  commitStatusTimes
} from '../../../../shared/source-control/checks/pr-check-time'
function mapGraphQLCheckRunContext(
  context: Extract<PRCheckContext, { __typename: 'CheckRun' }>
): PRCheckDetail | null {
  const name = nullableString(context.name)
  if (!name) {
    return null
  }
  const url = nullableString(context.detailsUrl) ?? nullableString(context.url)
  const checkRunId = nullableNumber(context.databaseId)
  const workflowRunId =
    nullableNumber(context.checkSuite?.workflowRun?.databaseId) ?? parseActionsRunId(url)
  return {
    name,
    status: mapCheckRunRESTStatus(context.status ?? ''),
    conclusion: mapCheckRunRESTConclusion(context.status ?? '', context.conclusion ?? null),
    url,
    ...checkRunTimes(context.startedAt, context.completedAt),
    ...(checkRunId !== null ? { checkRunId } : {}),
    ...(typeof workflowRunId === 'number' ? { workflowRunId } : {})
  }
}

function mapGraphQLStatusContext(
  context: Extract<PRCheckContext, { __typename: 'StatusContext' }>
): PRCheckDetail | null {
  const name = nullableString(context.context)
  if (!name) {
    return null
  }
  const url = nullableString(context.targetUrl)
  const workflowRunId = parseActionsRunId(url)
  const status = mapCommitStatusRESTStatus(context.state ?? '')
  return {
    name,
    status,
    conclusion: mapCommitStatusRESTConclusion(context.state ?? ''),
    url,
    ...commitStatusTimes(status, context.createdAt),
    ...(workflowRunId !== undefined ? { workflowRunId } : {})
  }
}

export function mapRestCheckRun(checkRun: RestCheckRun): PRCheckDetail {
  return {
    name: checkRun.name ?? '',
    status: mapCheckRunRESTStatus(checkRun.status),
    conclusion: mapCheckRunRESTConclusion(checkRun.status, checkRun.conclusion),
    url: checkRun.details_url || checkRun.html_url || null,
    ...checkRunTimes(checkRun.started_at, checkRun.completed_at),
    ...(typeof checkRun.id === 'number' ? { checkRunId: checkRun.id } : {}),
    workflowRunId: parseActionsRunId(checkRun.details_url || checkRun.html_url || null)
  }
}

export function mapRestCommitStatus(status: RestCommitStatus): PRCheckDetail | null {
  const name = nullableString(status.context)
  if (!name) {
    return null
  }
  const url = nullableString(status.target_url)
  const workflowRunId = parseActionsRunId(url)
  const checkStatus = mapCommitStatusRESTStatus(status.state ?? '')
  return {
    name,
    status: checkStatus,
    conclusion: mapCommitStatusRESTConclusion(status.state ?? ''),
    url,
    ...commitStatusTimes(checkStatus, status.created_at),
    ...(workflowRunId !== undefined ? { workflowRunId } : {})
  }
}

function mapGraphQLPendingApprovalCheckSuite(
  ownerRepo: GitHubApiRepository,
  suite: PRCheckSuite,
  headSha: string,
  index: number
): PRCheckDetail {
  return {
    name: getPendingApprovalCheckSuiteName(suite, headSha, index),
    status: 'completed',
    conclusion: 'action_required',
    // Approval blockers may have a suite URL without any check run.
    url:
      nullableString(suite.url) ??
      getPendingApprovalCheckSuiteUrl(ownerRepo, headSha, suite.databaseId)
  }
}

export function mapGraphQLPRCheckPages(
  ownerRepo: GitHubApiRepository,
  { contexts, suites, headSha }: PRCheckPages
): PRCheckDetail[] {
  const checkRunContexts = contexts.filter((context) => context.__typename === 'CheckRun')
  const checkRuns = checkRunContexts
    .map(mapGraphQLCheckRunContext)
    .filter((check): check is PRCheckDetail => check !== null)
  const checkRunNames = new Set(checkRuns.map((check) => check.name))
  const checkSuiteIdsWithRuns = new Set(
    checkRunContexts.map((context) => context.checkSuite.databaseId)
  )
  // Include legacy statuses, but preserve richer check-run metadata on name collisions.
  const legacyStatuses = contexts
    .filter((context) => context.__typename === 'StatusContext')
    .map(mapGraphQLStatusContext)
    .filter((check): check is PRCheckDetail => check !== null && !checkRunNames.has(check.name))
  const pendingApprovalChecks = suites
    .filter((suite) =>
      isPendingApprovalSuiteWithoutRuns(
        suite.conclusion,
        checkSuiteIdsWithRuns.has(suite.databaseId)
      )
    )
    .map((suite, index) => mapGraphQLPendingApprovalCheckSuite(ownerRepo, suite, headSha, index))

  const observedHeadSha = normalizePRCheckHeadSha(headSha)
  return [...checkRuns, ...legacyStatuses, ...pendingApprovalChecks].map((check) =>
    observedHeadSha ? { ...check, observedHeadSha } : check
  )
}

export function getPendingApprovalCheckSuiteName(
  suite: {
    id?: number | null
    databaseId?: number | null
    app?: { name?: string | null; slug?: string | null } | null
  },
  headSha: string | null | undefined,
  index: number
): string {
  const appName = suite.app?.name ?? suite.app?.slug ?? null
  const rawSuiteId = suite.databaseId ?? suite.id
  const suiteId =
    typeof rawSuiteId === 'number' && Number.isFinite(rawSuiteId) ? `#${rawSuiteId}` : null
  if (appName && suiteId) {
    return `${appName} ${suiteId}`
  }
  if (appName) {
    return appName
  }
  if (suiteId) {
    return suiteId
  }
  return `${headSha?.slice(0, 12) ?? 'check-suite'}:${index + 1}`
}

export function getPendingApprovalCheckSuiteUrl(
  ownerRepo: GitHubApiRepository,
  headSha: string,
  suiteId: number | null | undefined
): string {
  const base = `https://${githubRepositoryWebHost(ownerRepo)}/${ownerRepo.owner}/${ownerRepo.repo}/commits/${headSha}/checks`
  return typeof suiteId === 'number' && Number.isFinite(suiteId)
    ? `${base}#check-suite-${suiteId}`
    : base
}
