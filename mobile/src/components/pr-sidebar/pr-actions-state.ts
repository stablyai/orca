import type { GitHubPRMergeMethod, PRState } from '../../../../src/shared/types'

// Which actions the PR actions section may offer for a given PR state. Merged PRs
// expose only unlink (+ open-on-host elsewhere); closed PRs add reopen; open/draft
// keep the full set. Mirrors desktop, which hides merge/auto-merge once a PR is no
// longer open. Pure + unit-tested.
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
