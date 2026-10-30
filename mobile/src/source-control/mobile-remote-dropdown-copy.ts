import type { RemoteDropdownCopy } from '../../../src/shared/source-control-dropdown-remote-copy'
import type { Translate } from '../i18n/mobile-i18n'
import {
  localizedPushCount,
  localizedPullCount,
  localizedFastForwardCount,
  localizedSyncCounts,
  localizedForcePushWithLease,
  localizedManualForcePush,
  localizedUnpublishedForcePush
} from './mobile-source-control-count-copy'

export function mobileRemoteDropdownCopy(t: Translate): RemoteDropdownCopy {
  return {
    push: t('sourceControl.remoteDropdown.push', 'Push'),
    forcePush: t('sourceControl.remoteDropdown.forcePush', 'Force Push'),
    pull: t('sourceControl.remoteDropdown.pull', 'Pull'),
    fastForward: t('sourceControl.remoteDropdown.fastForward', 'Fast-forward'),
    sync: t('sourceControl.remoteDropdown.sync', 'Sync'),
    publishBranch: t('sourceControl.remoteDropdown.publishBranch', 'Publish Branch'),
    publishPrStatus: t('sourceControl.remoteDropdown.publishPrStatus', 'PR Status'),
    publishLinkedReview: t('sourceControl.remoteDropdown.publishLinkedReview', 'Linked Review'),
    publishNoBranch: t('sourceControl.remoteDropdown.publishNoBranch', 'No Branch'),
    checkingBranchStatus: t(
      'sourceControl.remoteDropdown.checkingBranchStatus',
      'Checking branch status…'
    ),
    checkingPrStatus: t('sourceControl.remoteDropdown.checkingPrStatus', 'Checking PR status…'),
    prAlreadyMerged: t('sourceControl.remoteDropdown.prAlreadyMerged', 'PR is already merged'),
    linkedReviewTargetUnavailable: t(
      'sourceControl.remoteDropdown.linkedReviewTargetUnavailable',
      'Linked review branch target is unavailable'
    ),
    checkOutBranchToPush: t(
      'sourceControl.remoteDropdown.checkOutBranchToPush',
      'Check out a branch before pushing commits'
    ),
    pushAndSetUpstream: t(
      'sourceControl.remoteDropdown.pushAndSetUpstream',
      'Push this branch and set an upstream if needed'
    ),
    pushToLinkedReview: t(
      'sourceControl.remoteDropdown.pushToLinkedReview',
      'Push updates to the linked review branch'
    ),
    tryRegularPush: t(
      'sourceControl.remoteDropdown.tryRegularPush',
      'Try a regular push; git may require force push'
    ),
    pushMayNeedSync: t(
      'sourceControl.remoteDropdown.pushMayNeedSync',
      'Push local commits; git may require syncing first'
    ),
    nothingToPush: t('sourceControl.remoteDropdown.nothingToPush', 'Nothing to push'),
    checkOutBranchToForcePush: t(
      'sourceControl.remoteDropdown.checkOutBranchToForcePush',
      'Check out a branch before force pushing commits'
    ),
    nothingToForcePush: t(
      'sourceControl.remoteDropdown.nothingToForcePush',
      'Nothing to force push'
    ),
    checkOutBranchToPull: t(
      'sourceControl.remoteDropdown.checkOutBranchToPull',
      'Check out a branch before pulling commits'
    ),
    publishBranchFirstToPull: t(
      'sourceControl.remoteDropdown.publishBranchFirstToPull',
      'Publish the branch first to pull commits'
    ),
    nothingNewToPull: t(
      'sourceControl.remoteDropdown.nothingNewToPull',
      'Nothing new to pull — remote only has older copies of local commits'
    ),
    nothingToPull: t('sourceControl.remoteDropdown.nothingToPull', 'Nothing to pull'),
    checkOutBranchToFastForward: t(
      'sourceControl.remoteDropdown.checkOutBranchToFastForward',
      'Check out a branch before fast-forwarding'
    ),
    publishBranchFirstToFastForward: t(
      'sourceControl.remoteDropdown.publishBranchFirstToFastForward',
      'Publish the branch first to fast-forward'
    ),
    nothingNewToFastForward: t(
      'sourceControl.remoteDropdown.nothingNewToFastForward',
      'Nothing new to fast-forward — remote only has older copies of local commits'
    ),
    nothingToFastForward: t(
      'sourceControl.remoteDropdown.nothingToFastForward',
      'Nothing to fast-forward'
    ),
    tryFastForwardPull: t(
      'sourceControl.remoteDropdown.tryFastForwardPull',
      'Try a fast-forward pull; git may reject local commits'
    ),
    checkOutBranchToSync: t(
      'sourceControl.remoteDropdown.checkOutBranchToSync',
      'Check out a branch before syncing commits'
    ),
    publishBranchFirstToSync: t(
      'sourceControl.remoteDropdown.publishBranchFirstToSync',
      'Publish the branch first to sync commits'
    ),
    useForcePushToSync: t(
      'sourceControl.remoteDropdown.useForcePushToSync',
      'Use Force Push — remote only has older copies of local commits'
    ),
    branchUpToDate: t('sourceControl.remoteDropdown.branchUpToDate', 'Branch is up to date'),
    rebaseFromBase: t('sourceControl.remoteDropdown.rebaseFromBase', 'Rebase from Base'),
    rebaseChooseRemoteBase: t(
      'sourceControl.remoteDropdown.rebaseChooseRemoteBase',
      'Choose a remote base branch to rebase from'
    ),
    rebaseDirtyHint: t(
      'sourceControl.remoteDropdown.rebaseDirtyHint',
      'Try rebasing; git may require committing or stashing local changes first'
    ),
    fetch: t('sourceControl.remoteDropdown.fetch', 'Fetch'),
    fetchTitle: t('sourceControl.remoteDropdown.fetchTitle', 'Fetch from remote without merging'),
    linkedReviewBranchExists: t(
      'sourceControl.remoteDropdown.linkedReviewBranchExists',
      'Linked review branch already exists'
    ),
    checkOutBranchToPublish: t(
      'sourceControl.remoteDropdown.checkOutBranchToPublish',
      'Check out a branch before publishing commits'
    ),
    branchAlreadyPublished: t(
      'sourceControl.remoteDropdown.branchAlreadyPublished',
      'Branch is already published'
    ),
    publishToOrigin: t(
      'sourceControl.remoteDropdown.publishToOrigin',
      'Publish this branch to origin'
    ),
    nothingToPushTo: (upstreamName) =>
      t('sourceControl.remoteDropdown.nothingToPushTo', 'Nothing to push to {{upstreamName}}', {
        upstreamName
      }),
    nothingToForcePushTo: (upstreamName) =>
      t(
        'sourceControl.remoteDropdown.nothingToForcePushTo',
        'Nothing to force push to {{upstreamName}}',
        { upstreamName }
      ),
    rebaseFromNamedBase: (baseRef) =>
      t('sourceControl.remoteDropdown.rebaseFromNamedBase', 'Rebase from {{baseRef}}', { baseRef }),
    rebaseWithLatestFrom: (baseRef) =>
      t(
        'sourceControl.remoteDropdown.rebaseWithLatestFrom',
        'Rebase current branch with latest commits from {{baseRef}}',
        { baseRef }
      ),
    pushCount: (count) => localizedPushCount(count, t),
    pullCount: (count) => localizedPullCount(count, t),
    fastForwardCount: (count) => localizedFastForwardCount(count, t),
    syncCounts: (ahead, behind) => localizedSyncCounts(ahead, behind, t),
    forcePushWithLease: (branchCommitsAhead, upstreamName) =>
      localizedForcePushWithLease(branchCommitsAhead, upstreamName, t),
    manualForcePush: (ahead, behind, upstreamName) =>
      localizedManualForcePush(ahead, behind, upstreamName, t),
    unpublishedForcePush: (branchCommitsAhead) =>
      localizedUnpublishedForcePush(branchCommitsAhead, t)
  }
}
