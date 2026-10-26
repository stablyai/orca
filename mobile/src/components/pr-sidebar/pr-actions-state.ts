import type { GitHubPRMergeMethod, PRState } from '../../../../src/shared/github/pull-request-types'

// Match desktop: merged PR only unlinks, closed adds reopen, open/draft retain full actions; hide merge once no longer open.
export type PrActionAvailability = {
  canMerge: boolean
  canAutoMerge: boolean
  canClose: boolean
  canReopen: boolean
  canUnlink: boolean
}

export function resolvePrActionAvailability(state: PRState): PrActionAvailability {
  const isOpen = state === 'open' || state === 'draft'
  return {
    canMerge: isOpen,
    canAutoMerge: isOpen,
    canClose: isOpen,
    canReopen: state === 'closed',
    canUnlink: true
  }
}

type MergeMethodSettings = {
  defaultMethod?: GitHubPRMergeMethod
  allowedMethods?: Record<GitHubPRMergeMethod, boolean>
}

const MOBILE_PR_MERGE_METHOD_FALLBACK_ORDER: GitHubPRMergeMethod[] = ['merge', 'squash', 'rebase']

export function resolveMobilePrMergeMethod(
  settings: MergeMethodSettings | null | undefined
): GitHubPRMergeMethod {
  const preferredMethod = settings?.defaultMethod ?? 'squash'
  const allowed = settings?.allowedMethods

  if (!allowed || allowed[preferredMethod]) {
    return preferredMethod
  }

  return MOBILE_PR_MERGE_METHOD_FALLBACK_ORDER.find((method) => allowed[method]) ?? preferredMethod
}
