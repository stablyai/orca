import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { githubRepositoryWebHost, type GitHubApiRepository } from '../../github-api-repository'
import {
  mapCheckRunRESTStatus,
  mapCheckRunRESTConclusion,
  mapCommitStatusRESTStatus,
  mapCommitStatusRESTConclusion
} from '../../mappers'
import type {
  GraphQLPRChecksResponse,
  GraphQLCheckRunContext,
  GraphQLStatusContext,
  GraphQLStatusCheckContext,
  GraphQLCheckSuite,
  RestCheckRun,
  RestCommitStatus
} from './pr-checks-graphql-query'
import { nullableString, nullableNumber, parseActionsRunId } from './check-detail-field-mapping'
export function isGraphQLCheckRunContext(
  context: GraphQLStatusCheckContext
): context is GraphQLCheckRunContext {
  return context.__typename === 'CheckRun'
}

export function isGraphQLStatusContext(
  context: GraphQLStatusCheckContext
): context is GraphQLStatusContext {
  return context.__typename === 'StatusContext'
}

export function mapGraphQLCheckRunContext(context: GraphQLCheckRunContext): PRCheckDetail | null {
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
    ...(checkRunId !== null ? { checkRunId } : {}),
    ...(typeof workflowRunId === 'number' ? { workflowRunId } : {})
  }
}

export function mapGraphQLStatusContext(context: GraphQLStatusContext): PRCheckDetail | null {
  const name = nullableString(context.context)
  if (!name) {
    return null
  }
  const url = nullableString(context.targetUrl)
  const workflowRunId = parseActionsRunId(url)
  return {
    name,
    status: mapCommitStatusRESTStatus(context.state ?? ''),
    conclusion: mapCommitStatusRESTConclusion(context.state ?? ''),
    url,
    ...(workflowRunId !== undefined ? { workflowRunId } : {})
  }
}

export function mapRestCheckRun(checkRun: RestCheckRun): PRCheckDetail {
  return {
    name: checkRun.name,
    status: mapCheckRunRESTStatus(checkRun.status),
    conclusion: mapCheckRunRESTConclusion(checkRun.status, checkRun.conclusion),
    url: checkRun.details_url || checkRun.html_url || null,
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
  return {
    name,
    status: mapCommitStatusRESTStatus(status.state ?? ''),
    conclusion: mapCommitStatusRESTConclusion(status.state ?? ''),
    url,
    ...(workflowRunId !== undefined ? { workflowRunId } : {})
  }
}

export function mapGraphQLPendingApprovalCheckSuite(
  ownerRepo: GitHubApiRepository,
  suite: GraphQLCheckSuite,
  headSha: string | null | undefined,
  index: number
): PRCheckDetail {
  return {
    name: getPendingApprovalCheckSuiteName(suite, headSha, index),
    status: 'completed',
    conclusion: 'action_required',
    // Why: suite-only approval blockers have no check run; link the suite page when GraphQL exposes one.
    url:
      nullableString(suite.url) ??
      (headSha ? getPendingApprovalCheckSuiteUrl(ownerRepo, headSha, suite.databaseId) : null)
  }
}

export function mapGraphQLPRChecksResponse(
  ownerRepo: GitHubApiRepository,
  response: GraphQLPRChecksResponse
): PRCheckDetail[] | null {
  const pullRequest = response.data?.repository?.pullRequest
  if (!pullRequest) {
    return null
  }
  const commit = pullRequest.commits?.nodes?.[0]?.commit
  if (!commit) {
    return []
  }

  const contexts = commit.statusCheckRollup?.contexts?.nodes ?? []
  const checkRunContexts = contexts.filter(isGraphQLCheckRunContext)
  const checkRuns = checkRunContexts
    .map(mapGraphQLCheckRunContext)
    .filter((check): check is PRCheckDetail => check !== null)
  const checkRunNames = new Set(checkRuns.map((check) => check.name))
  const checkSuiteIdsWithRuns = new Set(
    checkRunContexts
      .map((context) => nullableNumber(context.checkSuite?.databaseId))
      .filter((id): id is number => id !== null)
  )
  // Why: mixed-CI repos expose Jenkins/Prow/Tide as legacy status contexts in the same rollup; keep check-run metadata on name collisions.
  const legacyStatuses = contexts
    .filter(isGraphQLStatusContext)
    .map(mapGraphQLStatusContext)
    .filter((check): check is PRCheckDetail => check !== null && !checkRunNames.has(check.name))
  const pendingApprovalChecks = (commit.checkSuites?.nodes ?? [])
    .filter((suite) => suite.conclusion?.toLowerCase() === 'action_required')
    .filter((suite) => {
      const suiteId = nullableNumber(suite.databaseId)
      return suiteId === null || !checkSuiteIdsWithRuns.has(suiteId)
    })
    .map((suite, index) =>
      mapGraphQLPendingApprovalCheckSuite(ownerRepo, suite, pullRequest.headRefOid, index)
    )

  return [...checkRuns, ...legacyStatuses, ...pendingApprovalChecks]
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
