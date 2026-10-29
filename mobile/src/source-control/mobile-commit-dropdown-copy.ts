import type { CommitDropdownCopy } from '../../../src/shared/source-control-dropdown-commit-items'
import type { Translate } from '../i18n/mobile-i18n'

export function mobileCommitDropdownCopy(t: Translate): CommitDropdownCopy {
  return {
    commit: t('sourceControl.commitDropdown.commit', 'Commit'),
    commitStagedChanges: t(
      'sourceControl.commitDropdown.commitStagedChanges',
      'Commit staged changes'
    ),
    commitPush: t('sourceControl.commitDropdown.commitPush', 'Commit & Push'),
    commitForcePush: t('sourceControl.commitDropdown.commitForcePush', 'Commit & Force Push'),
    commitSync: t('sourceControl.commitDropdown.commitSync', 'Commit & Sync'),
    checkingBranchStatus: t(
      'sourceControl.commitDropdown.checkingBranchStatus',
      'Checking branch status…'
    ),
    checkingPrStatus: t('sourceControl.commitDropdown.checkingPrStatus', 'Checking PR status…'),
    prAlreadyMerged: t('sourceControl.commitDropdown.prAlreadyMerged', 'PR is already merged'),
    checkOutBranchToPush: t(
      'sourceControl.commitDropdown.checkOutBranchToPush',
      'Check out a branch before pushing commits'
    ),
    linkedReviewTargetUnavailable: t(
      'sourceControl.commitDropdown.linkedReviewTargetUnavailable',
      'Linked review branch target is unavailable'
    ),
    publishBranchFirstToPush: t(
      'sourceControl.commitDropdown.publishBranchFirstToPush',
      'Publish the branch first to push commits'
    ),
    commitAndForcePush: t(
      'sourceControl.commitDropdown.commitAndForcePush',
      'Commit staged changes and force push with lease'
    ),
    commitAndTryPush: t(
      'sourceControl.commitDropdown.commitAndTryPush',
      'Commit staged changes and try to push'
    ),
    commitAndPush: t(
      'sourceControl.commitDropdown.commitAndPush',
      'Commit staged changes and push'
    ),
    checkOutBranchToSync: t(
      'sourceControl.commitDropdown.checkOutBranchToSync',
      'Check out a branch before syncing commits'
    ),
    publishBranchFirstToSync: t(
      'sourceControl.commitDropdown.publishBranchFirstToSync',
      'Publish the branch first to sync commits'
    ),
    useCommitAndForcePush: t(
      'sourceControl.commitDropdown.useCommitAndForcePush',
      'Use Commit & Force Push — remote only has older copies of local commits'
    ),
    commitThenPullPush: t(
      'sourceControl.commitDropdown.commitThenPullPush',
      'Commit, then pull and push'
    ),
    amendCommit: t('sourceControl.commitDropdown.amendCommit', 'Amend commit'),
    amendFoldTitle: t(
      'sourceControl.commitDropdown.amendFoldTitle',
      'Fold staged changes into the last commit; the entered message replaces the old one'
    ),
    amendCreateInitialCommit: t(
      'sourceControl.commitDropdown.amendCreateInitialCommit',
      'Create an initial commit before amending'
    ),
    amendResolveConflicts: t(
      'sourceControl.commitDropdown.amendResolveConflicts',
      'Resolve conflicts before amending'
    ),
    amendEnterMessageOrStage: t(
      'sourceControl.commitDropdown.amendEnterMessageOrStage',
      'Enter a message or stage changes to amend'
    ),
    amendDisabledReason: (reason) => {
      switch (reason) {
        case 'Create an initial commit before amending':
          return t(
            'sourceControl.commitDropdown.amendCreateInitialCommit',
            'Create an initial commit before amending'
          )
        case 'Resolve conflicts before amending':
          return t(
            'sourceControl.commitDropdown.amendResolveConflicts',
            'Resolve conflicts before amending'
          )
        case 'Enter a message or stage changes to amend':
          return t(
            'sourceControl.commitDropdown.amendEnterMessageOrStage',
            'Enter a message or stage changes to amend'
          )
      }
    },
    commitDisabledReason: (reason) => {
      switch (reason) {
        case 'Resolve conflicts before committing':
          return t(
            'sourceControl.commitDropdown.resolveConflicts',
            'Resolve conflicts before committing'
          )
        case 'Stage at least one file to commit':
          return t('sourceControl.commitDropdown.stageFile', 'Stage at least one file to commit')
        case 'Enter a commit message to commit':
          return t('sourceControl.commitDropdown.enterMessage', 'Enter a commit message to commit')
      }
    }
  }
}
