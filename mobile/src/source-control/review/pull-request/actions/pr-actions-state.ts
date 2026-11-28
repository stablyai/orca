import type {
  GitHubPRMergeMethod,
  PRInfo
} from '../../../../../../src/shared/github/pull-requests/pull-request-types'
import {
  resolveGitHubPRMergeState,
  type GitHubPRMergeStateKind
} from '../../../../../../src/shared/github/pull-requests/merge/pull-request-merge-state'
import {
  resolveGitHubPRStackMergeDecision,
  type GitHubPRStackMergeBlocker
} from '../../../../../../src/shared/github/pull-requests/merge/pull-request-stack-merge'
import type { Translate } from '../../../../i18n/mobile-i18n'

// Copy for desktop’s merge-state kinds; the shared rule decides which one applies.
function prMergeStateCopy(
  t: Translate
): Record<GitHubPRMergeStateKind, { label: string; hint: string }> {
  return {
    merged: {
      label: t('pullRequest.prActionsState.mergedLabel', 'Merged'),
      hint: t('pullRequest.prActionsState.mergedHint', 'This pull request is already merged')
    },
    closed: {
      label: t('pullRequest.prActionsState.closedLabel', 'Closed'),
      hint: t('pullRequest.prActionsState.closedHint', 'This pull request is closed')
    },
    draft: {
      label: t('pullRequest.prActionsState.draftLabel', 'Draft'),
      hint: t('pullRequest.prActionsState.draftHint', 'This pull request is still a draft')
    },
    review_required: {
      label: t('pullRequest.prActionsState.reviewRequiredLabel', 'Approval required'),
      hint: t(
        'pullRequest.prActionsState.reviewRequiredHint',
        'GitHub requires review approval before this pull request can merge'
      )
    },
    changes_requested: {
      label: t('pullRequest.prActionsState.changesRequestedLabel', 'Changes requested'),
      hint: t(
        'pullRequest.prActionsState.changesRequestedHint',
        'GitHub reports requested changes on this pull request'
      )
    },
    conflicts: {
      label: t('pullRequest.prActionsState.conflictsLabel', 'Conflicts'),
      hint: t('pullRequest.prActionsState.conflictsHint', 'GitHub reports merge conflicts')
    },
    merge_queue: {
      label: t('pullRequest.prActionsState.mergeQueueLabel', 'Merge when ready'),
      hint: t(
        'pullRequest.prActionsState.mergeQueueHint',
        'This base branch uses GitHub merge queue'
      )
    },
    merge_queue_auto_merge_on: {
      label: t('pullRequest.prActionsState.mergeQueueAutoMergeOnLabel', 'Auto-merge on'),
      hint: t(
        'pullRequest.prActionsState.mergeQueueAutoMergeOnHint',
        'This base branch uses GitHub merge queue'
      )
    },
    merge_status_unavailable: {
      label: t('pullRequest.prActionsState.mergeStatusUnavailableLabel', 'Merge'),
      hint: t(
        'pullRequest.prActionsState.mergeStatusUnavailableHint',
        'Merge status is unavailable for this PR'
      )
    },
    behind: {
      label: t('pullRequest.prActionsState.behindLabel', 'Behind'),
      hint: t('pullRequest.prActionsState.behindHint', 'Update the branch before merging')
    },
    blocked: {
      label: t('pullRequest.prActionsState.blockedLabel', 'Blocked'),
      hint: t(
        'pullRequest.prActionsState.blockedHint',
        'GitHub reports this pull request is blocked'
      )
    },
    mergeable_checks_failed: {
      label: t('pullRequest.prActionsState.mergeableChecksFailedLabel', 'Checks failed'),
      hint: t(
        'pullRequest.prActionsState.mergeableChecksFailedHint',
        'GitHub says this PR can merge, but some checks failed'
      )
    },
    mergeable_checks_pending: {
      label: t('pullRequest.prActionsState.mergeableChecksPendingLabel', 'Checks pending'),
      hint: t(
        'pullRequest.prActionsState.mergeableChecksPendingHint',
        'GitHub says this PR can merge, but checks are still running'
      )
    },
    mergeable_checks_passed: {
      label: t('pullRequest.prActionsState.mergeableChecksPassedLabel', 'Able to merge'),
      hint: t(
        'pullRequest.prActionsState.mergeableChecksPassedHint',
        'GitHub says this PR can merge and checks passed'
      )
    },
    mergeable: {
      label: t('pullRequest.prActionsState.mergeableLabel', 'Able to merge'),
      hint: t('pullRequest.prActionsState.mergeableHint', 'GitHub says this PR can merge')
    },
    checks_passed: {
      label: t('pullRequest.prActionsState.checksPassedLabel', 'Checks passed'),
      hint: t(
        'pullRequest.prActionsState.checksPassedHint',
        'Checks passed. Merge eligibility will be checked again before merging.'
      )
    },
    checking: {
      label: t('pullRequest.prActionsState.checkingLabel', 'Checking'),
      hint: t(
        'pullRequest.prActionsState.checkingHint',
        'GitHub is still computing this pull request merge status'
      )
    }
  }
}

function stackBlockerCopy(
  { prNumber: number, reason }: GitHubPRStackMergeBlocker,
  t: Translate
): string {
  const copy: Record<GitHubPRStackMergeBlocker['reason'], string> = {
    draft: t('pullRequest.prActionsState.stackDraft', '#{{number}} is still a draft.', {
      number
    }),
    closed: t('pullRequest.prActionsState.stackClosed', '#{{number}} is closed.', {
      number
    }),
    conflicts: t('pullRequest.prActionsState.stackConflicts', '#{{number}} has merge conflicts.', {
      number
    }),
    changes_requested: t(
      'pullRequest.prActionsState.stackChangesRequested',
      '#{{number}} has requested changes.',
      { number }
    ),
    review_required: t(
      'pullRequest.prActionsState.stackReviewRequired',
      '#{{number}} still needs review approval.',
      { number }
    ),
    behind: t('pullRequest.prActionsState.stackBehind', '#{{number}} must be updated.', {
      number
    }),
    blocked: t('pullRequest.prActionsState.stackBlocked', '#{{number}} is blocked.', {
      number
    })
  }
  return copy[reason]
}

// Desktop's merge-method labels; the desktop renderer translates the same three.
function mergeMethodLabels(t: Translate): Record<GitHubPRMergeMethod, string> {
  return {
    merge: t('pullRequest.prActionsState.methodMerge', 'Create merge commit'),
    squash: t('pullRequest.prActionsState.methodSquash', 'Squash and merge'),
    rebase: t('pullRequest.prActionsState.methodRebase', 'Rebase and merge')
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
  defaultMethod: GitHubPRMergeMethod,
  t: Translate
): PrMergePresentation {
  const decision = resolveGitHubPRMergeState(pr)
  const blockedCopy = prMergeStateCopy(t)[decision.kind]
  if (!pr.stack) {
    return {
      enabled: decision.directMergeAvailable,
      label: decision.directMergeAvailable
        ? mergeMethodLabels(t)[defaultMethod]
        : blockedCopy.label,
      hint: decision.directMergeAvailable ? null : blockedCopy.hint,
      confirmMessage: t(
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
      ? t(
          'pullRequest.prActionsState.queueThrough_one',
          'Queue through #{{number}} · {{count}} PR',
          { number: pr.number, count }
        )
      : t(
          'pullRequest.prActionsState.queueThrough_other',
          'Queue through #{{number}} · {{count}} PRs',
          { number: pr.number, count }
        )
    : count === 1
      ? t(
          'pullRequest.prActionsState.mergeThrough_one',
          'Merge through #{{number}} · {{count}} PR',
          { number: pr.number, count }
        )
      : t(
          'pullRequest.prActionsState.mergeThrough_other',
          'Merge through #{{number}} · {{count}} PRs',
          { number: pr.number, count }
        )
  const stackScope = usesMergeQueue
    ? t(
        'pullRequest.prActionsState.queueStackMessage',
        'GitHub will add this pull request and every pull request below it to the merge queue.'
      )
    : t(
        'pullRequest.prActionsState.mergeStackMessage',
        'GitHub will merge this pull request and every pull request below it in the stack.'
      )
  return {
    enabled,
    label: stackLabel,
    hint: blocker ? stackBlockerCopy(blocker, t) : enabled ? null : stackScope,
    confirmMessage: stackScope,
    showAutoMerge: false
  }
}
