import type { CheckPresentationStatus, CheckStatus } from '../../shared/github/pull-request-types'
import { derivePRCheckStatusesFromRollup } from '../../shared/pr-check-status'

export type GitHubPRStackCheckRollup = {
  state?: unknown
  contexts?: {
    totalCount?: unknown
    pageInfo?: { hasNextPage?: unknown } | null
    nodes?: unknown
  } | null
}

function completeStackCheckContexts(rollup: GitHubPRStackCheckRollup): unknown[] | null {
  const contexts = rollup.contexts
  const totalCount = contexts?.totalCount
  const nodes = contexts?.nodes
  if (
    !Number.isInteger(totalCount) ||
    (totalCount as number) <= 0 ||
    contexts?.pageInfo?.hasNextPage !== false ||
    !Array.isArray(nodes) ||
    nodes.length !== totalCount
  ) {
    return null
  }
  const valid = nodes.every((node) => {
    if (!node || typeof node !== 'object') {
      return false
    }
    const context = node as Record<string, unknown>
    if (context.__typename === 'CheckRun') {
      return (
        typeof context.status === 'string' &&
        (typeof context.conclusion === 'string' || context.conclusion === null)
      )
    }
    return context.__typename === 'StatusContext' && typeof context.state === 'string'
  })
  return valid ? nodes : null
}

export function deriveStackChecksPresentationStatus(
  rollup: GitHubPRStackCheckRollup,
  checksStatus: CheckStatus
): CheckPresentationStatus | undefined {
  if (checksStatus !== 'failure') {
    return undefined
  }
  const contexts = completeStackCheckContexts(rollup)
  if (!contexts) {
    return undefined
  }
  const derived = derivePRCheckStatusesFromRollup(contexts)
  return derived.status === 'failure' && derived.presentationStatus === 'cancelled'
    ? 'cancelled'
    : undefined
}
