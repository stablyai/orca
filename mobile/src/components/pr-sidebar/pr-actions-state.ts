import type {
  GitHubPRMergeMethod,
  PRInfo,
  PRState
} from '../../../../src/shared/github/pull-request-types'
import {
  resolveGitHubPRMergeState,
  type GitHubPRMergeStateKind
} from '../../../../src/shared/github/pull-request-merge-state'
import {
  resolveGitHubPRStackMergeDecision,
  type GitHubPRStackMergeBlocker
} from '../../../../src/shared/github/pull-request-stack-merge'

// Match desktop: drafts offer Ready for review and Close, never Merge; merged PRs only unlink.
export type PrActionAvailability = {
  canMerge: boolean
  canMarkReady: boolean
  canClose: boolean
  canReopen: boolean
  canUnlink: boolean
}

export function resolvePrActionAvailability(state: PRState): PrActionAvailability {
  return {
    canMerge: state === 'open',
    canMarkReady: state === 'draft',
    canClose: state === 'open' || state === 'draft',
    canReopen: state === 'closed',
    canUnlink: true
  }
}

// English copy for desktop's merge-state kinds; the shared rule decides which one applies.
const PR_MERGE_STATE_COPY: Record<GitHubPRMergeStateKind, { label: string; hint: string }> = {
  merged: { label: 'Merged', hint: 'This pull request is already merged' },
  closed: { label: 'Closed', hint: 'This pull request is closed' },
  draft: { label: 'Draft', hint: 'This pull request is still a draft' },
  review_required: {
    label: 'Approval required',
    hint: 'GitHub requires review approval before this pull request can merge'
  },
  changes_requested: {
    label: 'Changes requested',
    hint: 'GitHub reports requested changes on this pull request'
  },
  conflicts: { label: 'Conflicts', hint: 'GitHub reports merge conflicts' },
  merge_queue: {
    label: 'Merge when ready',
    hint: 'This base branch uses GitHub merge queue'
  },
  merge_queue_auto_merge_on: {
    label: 'Auto-merge on',
    hint: 'This base branch uses GitHub merge queue'
  },
  merge_status_unavailable: {
    label: 'Merge',
    hint: 'Merge status is unavailable for this PR'
  },
  behind: { label: 'Behind', hint: 'Update the branch before merging' },
  blocked: {
    label: 'Blocked',
    hint: 'GitHub reports this pull request is blocked'
  },
  mergeable_checks_failed: {
    label: 'Checks failed',
    hint: 'GitHub says this PR can merge, but some checks failed'
  },
  mergeable_checks_pending: {
    label: 'Checks pending',
    hint: 'GitHub says this PR can merge, but checks are still running'
  },
  mergeable_checks_passed: {
    label: 'Able to merge',
    hint: 'GitHub says this PR can merge and checks passed'
  },
  mergeable: { label: 'Able to merge', hint: 'GitHub says this PR can merge' },
  checks_passed: {
    label: 'Checks passed',
    hint: 'Checks passed. Merge eligibility will be checked again before merging.'
  },
  checking: {
    label: 'Checking',
    hint: 'GitHub is still computing this pull request merge status'
  }
}

const STACK_BLOCKER_COPY: Record<GitHubPRStackMergeBlocker['reason'], string> = {
  draft: 'is still a draft.',
  closed: 'is closed.',
  conflicts: 'has merge conflicts.',
  changes_requested: 'has requested changes.',
  review_required: 'still needs review approval.',
  behind: 'must be updated.',
  blocked: 'is blocked.'
}

// Desktop's merge-method labels; the desktop renderer translates the same three.
const MERGE_METHOD_LABELS: Record<GitHubPRMergeMethod, string> = {
  merge: 'Create merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

export type PrMergePresentation = {
  enabled: boolean
  label: string
  hint: string | null
  confirmMessage: string
  showAutoMerge: boolean
}

// Desktop's merge gating, stack override included; GitHub merges a stacked PR with everything below it.
export function presentPrMerge(
  pr: PRInfo,
  defaultMethod: GitHubPRMergeMethod
): PrMergePresentation {
  const decision = resolveGitHubPRMergeState(pr)
  const blockedCopy = PR_MERGE_STATE_COPY[decision.kind]
  if (!pr.stack) {
    return {
      enabled: decision.directMergeAvailable,
      label: decision.directMergeAvailable ? MERGE_METHOD_LABELS[defaultMethod] : blockedCopy.label,
      hint: decision.directMergeAvailable ? null : blockedCopy.hint,
      confirmMessage: `This will merge #${pr.number} into its base branch.`,
      showAutoMerge: decision.autoMergeAction !== null
    }
  }
  const {
    scope,
    blocker,
    usesMergeQueue,
    directMergeAvailable: enabled
  } = resolveGitHubPRStackMergeDecision({
    stack: pr.stack,
    reviewMergeQueueRequired: pr.mergeQueueRequired,
    stackMergeQueueRequired: undefined,
    directMergeAvailable: decision.directMergeAvailable
  })
  const stackLabel = `${usesMergeQueue ? 'Queue' : 'Merge'} through #${pr.number} · ${scope.count} ${scope.count === 1 ? 'PR' : 'PRs'}`
  const stackScope = usesMergeQueue
    ? 'GitHub will add this pull request and every pull request below it to the merge queue.'
    : 'GitHub will merge this pull request and every pull request below it in the stack.'
  return {
    enabled,
    label: stackLabel,
    hint: blocker
      ? `#${blocker.prNumber} ${STACK_BLOCKER_COPY[blocker.reason]}`
      : enabled
        ? null
        : stackScope,
    confirmMessage: stackScope,
    showAutoMerge: false
  }
}
