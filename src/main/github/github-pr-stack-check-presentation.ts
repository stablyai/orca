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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function completeStackCheckContexts(rollup: GitHubPRStackCheckRollup): unknown[] | null {
  const contexts = rollup.contexts
  const totalCount = contexts?.totalCount
  const nodes = contexts?.nodes
  if (
    typeof totalCount !== 'number' ||
    !Number.isInteger(totalCount) ||
    totalCount <= 0 ||
    contexts?.pageInfo?.hasNextPage !== false ||
    !Array.isArray(nodes) ||
    nodes.length !== totalCount
  ) {
    return null
  }
  const valid = nodes.every((node: unknown) => {
    if (!isRecord(node)) {
      return false
    }
    if (node.__typename === 'CheckRun') {
      return (
        typeof node.status === 'string' &&
        (typeof node.conclusion === 'string' || node.conclusion === null)
      )
    }
    return node.__typename === 'StatusContext' && typeof node.state === 'string'
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
