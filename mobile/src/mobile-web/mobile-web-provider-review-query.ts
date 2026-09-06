import {
  MobileWebProviderReviewQueryPayloadSchema,
  MobileWebProviderReviewQueryResultSchema,
  type MobileWebProviderReviewQueryPayload,
  type MobileWebProviderReviewQueryResult
} from '../../../src/shared/mobile-web/provider-review-query-contract'
import type { MobileWebProviderReview } from '../../../src/shared/mobile-web/provider-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-hosted-review-service'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { sanitizeMobileWebProviderReviewDetails } from './mobile-web-provider-review-sanitizer'
import {
  assertCurrentRepositoryIdentity,
  readHostedReviewSummary,
  readProviderDetails
} from './mobile-web-provider-review-state'
import { githubProviderReviewTarget } from './mobile-web-provider-review-targets'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebProviderReviewQuery(args: {
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<MobileWebProviderReviewQueryResult> {
  const payload = MobileWebProviderReviewQueryPayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  await assertCurrentRepositoryIdentity(args.client, hostWorkspaceId, payload)
  const repo = mobileRepoSelectorFromWorktreeId(hostWorkspaceId)
  const summary = await readHostedReviewSummary(args.client, repo, payload)
  if (
    !summary ||
    summary.provider !== payload.provider ||
    summary.number !== payload.reviewNumber
  ) {
    throw new MobileWebBrokerError('conflict')
  }
  const details = await readProviderDetails(args.client, repo, summary)
  const review = sanitizeMobileWebProviderReviewDetails(summary, details)
  if (review.detailsState !== 'loaded' || review.provider !== 'github') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  return payload.query === 'assignableUsers'
    ? queryAssignableUsers(args.client, repo, payload)
    : queryCheckDetails(args.client, repo, payload, review, details)
}

async function queryAssignableUsers(
  client: RpcClient,
  repo: string,
  payload: Extract<MobileWebProviderReviewQueryPayload, { query: 'assignableUsers' }>
): Promise<MobileWebProviderReviewQueryResult> {
  const response = await client.sendRequest('github.listAssignableUsers', { repo })
  if (!response.ok || !Array.isArray(response.result)) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebProviderReviewQueryResultSchema.parse({
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    query: payload.query,
    users: response.result.flatMap((value) => {
      if (!isRecord(value) || !boundedString(value.login, 80)) {
        return []
      }
      return [
        {
          login: boundedString(value.login, 80),
          name: boundedString(value.name, 160) || null
        }
      ]
    })
  })
}

async function queryCheckDetails(
  client: RpcClient,
  repo: string,
  payload: Extract<MobileWebProviderReviewQueryPayload, { query: 'checkDetails' }>,
  review: MobileWebProviderReview,
  details: unknown
): Promise<MobileWebProviderReviewQueryResult> {
  const check = review.checks.find((candidate) => checkMatchesPayload(candidate, payload))
  if (!check) {
    throw new MobileWebBrokerError('conflict')
  }
  const response = await client.sendRequest('github.prCheckDetails', {
    repo,
    checkName: check.name,
    ...(check.checkRunId ? { checkRunId: check.checkRunId } : {}),
    ...(check.workflowRunId ? { workflowRunId: check.workflowRunId } : {}),
    ...githubProviderReviewTarget(details)
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return MobileWebProviderReviewQueryResultSchema.parse({
    workspaceId: payload.workspaceId,
    provider: payload.provider,
    reviewNumber: payload.reviewNumber,
    query: payload.query,
    details: sanitizeCheckDetails(response.result)
  })
}

function checkMatchesPayload(
  check: MobileWebProviderReview['checks'][number],
  payload: Extract<MobileWebProviderReviewQueryPayload, { query: 'checkDetails' }>
): boolean {
  return (
    check.name === payload.checkName &&
    check.checkRunId === payload.checkRunId &&
    check.workflowRunId === payload.workflowRunId
  )
}

function sanitizeCheckDetails(value: unknown) {
  if (!isRecord(value) || !boundedString(value.name, 256)) {
    return null
  }
  return {
    name: boundedString(value.name, 256),
    status: nullableText(value.status, 80),
    conclusion: nullableText(value.conclusion, 80),
    startedAt: nullableText(value.startedAt, 64),
    completedAt: nullableText(value.completedAt, 64),
    title: nullableText(value.title, 512),
    summary: nullableText(value.summary, 16 * 1024),
    annotations: sanitizeAnnotations(value.annotations),
    jobs: sanitizeJobs(value.jobs)
  }
}

function sanitizeAnnotations(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) =>
      isRecord(entry)
        ? [
            {
              path: nullableText(entry.path, 1024),
              startLine: positiveInteger(entry.startLine),
              endLine: positiveInteger(entry.endLine),
              annotationLevel: nullableText(entry.annotationLevel, 80),
              title: nullableText(entry.title, 512),
              message: boundedString(entry.message, 8 * 1024)
            }
          ]
        : []
    )
    .slice(0, 20)
}

function sanitizeJobs(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) =>
      isRecord(entry)
        ? [
            {
              name: boundedString(entry.name, 256),
              status: nullableText(entry.status, 80),
              conclusion: nullableText(entry.conclusion, 80),
              logTail: nullableText(entry.logTail, 32 * 1024),
              steps: sanitizeSteps(entry.steps)
            }
          ]
        : []
    )
    .slice(0, 100)
}

function sanitizeSteps(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .flatMap((entry) =>
      isRecord(entry)
        ? [
            {
              name: boundedString(entry.name, 256),
              status: nullableText(entry.status, 80),
              conclusion: nullableText(entry.conclusion, 80)
            }
          ]
        : []
    )
    .slice(0, 100)
}

function boundedString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function nullableText(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? value.slice(0, limit) : null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
