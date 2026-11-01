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
import { translate } from '../../i18n/mobile-i18n'

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

// Copy for desktop’s merge-state kinds; the shared rule decides which one applies.
function prMergeStateCopy(): Record<GitHubPRMergeStateKind, { label: string; hint: string }> {
  return {
    merged: {
      label: translate('pullRequest.prActionsState.mergedLabel', 'Merged'),
      hint: translate(
        'pullRequest.prActionsState.mergedHint',
        'This pull request is already merged'
      )
    },
    closed: {
      label: translate('pullRequest.prActionsState.closedLabel', 'Closed'),
      hint: translate('pullRequest.prActionsState.closedHint', 'This pull request is closed')
    },
    draft: {
      label: translate('pullRequest.prActionsState.draftLabel', 'Draft'),
      hint: translate('pullRequest.prActionsState.draftHint', 'This pull request is still a draft')
    },
    review_required: {
      label: translate('pullRequest.prActionsState.reviewRequiredLabel', 'Approval required'),
      hint: translate(
        'pullRequest.prActionsState.reviewRequiredHint',
        'GitHub requires review approval before this pull request can merge'
      )
    },
    changes_requested: {
      label: translate('pullRequest.prActionsState.changesRequestedLabel', 'Changes requested'),
      hint: translate(
        'pullRequest.prActionsState.changesRequestedHint',
        'GitHub reports requested changes on this pull request'
      )
    },
    conflicts: {
      label: translate('pullRequest.prActionsState.conflictsLabel', 'Conflicts'),
      hint: translate('pullRequest.prActionsState.conflictsHint', 'GitHub reports merge conflicts')
    },
    merge_queue: {
      label: translate('pullRequest.prActionsState.mergeQueueLabel', 'Merge when ready'),
      hint: translate(
        'pullRequest.prActionsState.mergeQueueHint',
        'This base branch uses GitHub merge queue'
      )
    },
    merge_queue_auto_merge_on: {
      label: translate('pullRequest.prActionsState.mergeQueueAutoMergeOnLabel', 'Auto-merge on'),
      hint: translate(
        'pullRequest.prActionsState.mergeQueueAutoMergeOnHint',
        'This base branch uses GitHub merge queue'
      )
    },
    merge_status_unavailable: {
      label: translate('pullRequest.prActionsState.mergeStatusUnavailableLabel', 'Merge'),
      hint: translate(
        'pullRequest.prActionsState.mergeStatusUnavailableHint',
        'Merge status is unavailable for this PR'
      )
    },
    behind: {
      label: translate('pullRequest.prActionsState.behindLabel', 'Behind'),
      hint: translate('pullRequest.prActionsState.behindHint', 'Update the branch before merging')
    },
    blocked: {
      label: translate('pullRequest.prActionsState.blockedLabel', 'Blocked'),
      hint: translate(
        'pullRequest.prActionsState.blockedHint',
        'GitHub reports this pull request is blocked'
      )
    },
    mergeable_checks_failed: {
      label: translate('pullRequest.prActionsState.mergeableChecksFailedLabel', 'Checks failed'),
      hint: translate(
        'pullRequest.prActionsState.mergeableChecksFailedHint',
        'GitHub says this PR can merge, but some checks failed'
      )
    },
    mergeable_checks_pending: {
      label: translate('pullRequest.prActionsState.mergeableChecksPendingLabel', 'Checks pending'),
      hint: translate(
        'pullRequest.prActionsState.mergeableChecksPendingHint',
        'GitHub says this PR can merge, but checks are still running'
      )
    },
    mergeable_checks_passed: {
      label: translate('pullRequest.prActionsState.mergeableChecksPassedLabel', 'Able to merge'),
      hint: translate(
        'pullRequest.prActionsState.mergeableChecksPassedHint',
        'GitHub says this PR can merge and checks passed'
      )
    },
    mergeable: {
      label: translate('pullRequest.prActionsState.mergeableLabel', 'Able to merge'),
      hint: translate('pullRequest.prActionsState.mergeableHint', 'GitHub says this PR can merge')
    },
    checks_passed: {
      label: translate('pullRequest.prActionsState.checksPassedLabel', 'Checks passed'),
      hint: translate(
        'pullRequest.prActionsState.checksPassedHint',
        'Checks passed. Merge eligibility will be checked again before merging.'
      )
    },
    checking: {
      label: translate('pullRequest.prActionsState.checkingLabel', 'Checking'),
      hint: translate(
        'pullRequest.prActionsState.checkingHint',
        'GitHub is still computing this pull request merge status'
      )
    }
  }
}

function stackBlockerCopy({ prNumber: number, reason }: GitHubPRStackMergeBlocker): string {
  const copy: Record<GitHubPRStackMergeBlocker['reason'], string> = {
    draft: translate('pullRequest.prActionsState.stackDraft', '#{{number}} is still a draft.', {
      number
    }),
    closed: translate('pullRequest.prActionsState.stackClosed', '#{{number}} is closed.', {
      number
    }),
    conflicts: translate(
      'pullRequest.prActionsState.stackConflicts',
      '#{{number}} has merge conflicts.',
      { number }
    ),
    changes_requested: translate(
      'pullRequest.prActionsState.stackChangesRequested',
      '#{{number}} has requested changes.',
      { number }
    ),
    review_required: translate(
      'pullRequest.prActionsState.stackReviewRequired',
      '#{{number}} still needs review approval.',
      { number }
    ),
    behind: translate('pullRequest.prActionsState.stackBehind', '#{{number}} must be updated.', {
      number
    }),
    blocked: translate('pullRequest.prActionsState.stackBlocked', '#{{number}} is blocked.', {
      number
    })
  }
  return copy[reason]
}

// Desktop's merge-method labels; the desktop renderer translates the same three.
function mergeMethodLabels(): Record<GitHubPRMergeMethod, string> {
  return {
    merge: translate('pullRequest.prActionsState.methodMerge', 'Create merge commit'),
    squash: translate('pullRequest.prActionsState.methodSquash', 'Squash and merge'),
    rebase: translate('pullRequest.prActionsState.methodRebase', 'Rebase and merge')
  }
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
  const blockedCopy = prMergeStateCopy()[decision.kind]
  if (!pr.stack) {
    return {
      enabled: decision.directMergeAvailable,
      label: decision.directMergeAvailable ? mergeMethodLabels()[defaultMethod] : blockedCopy.label,
      hint: decision.directMergeAvailable ? null : blockedCopy.hint,
      confirmMessage: translate(
        'pullRequest.prActionsState.mergeConfirmMessage',
        'This will merge #{{number}} into its base branch.',
        { number: pr.number }
      ),
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
  const count = scope.count
  const stackLabel = usesMergeQueue
    ? count === 1
      ? translate(
          'pullRequest.prActionsState.queueThrough_one',
          'Queue through #{{number}} · {{count}} PR',
          { number: pr.number, count }
        )
      : translate(
          'pullRequest.prActionsState.queueThrough_other',
          'Queue through #{{number}} · {{count}} PRs',
          { number: pr.number, count }
        )
    : count === 1
      ? translate(
          'pullRequest.prActionsState.mergeThrough_one',
          'Merge through #{{number}} · {{count}} PR',
          { number: pr.number, count }
        )
      : translate(
          'pullRequest.prActionsState.mergeThrough_other',
          'Merge through #{{number}} · {{count}} PRs',
          { number: pr.number, count }
        )
  const stackScope = usesMergeQueue
    ? translate(
        'pullRequest.prActionsState.queueStackMessage',
        'GitHub will add this pull request and every pull request below it to the merge queue.'
      )
    : translate(
        'pullRequest.prActionsState.mergeStackMessage',
        'GitHub will merge this pull request and every pull request below it in the stack.'
      )
  return {
    enabled,
    label: stackLabel,
    hint: blocker ? stackBlockerCopy(blocker) : enabled ? null : stackScope,
    confirmMessage: stackScope,
    showAutoMerge: false
  }
}
