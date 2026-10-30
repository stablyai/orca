import { translate } from '../i18n/mobile-i18n'
import type { Translate } from '../i18n/mobile-i18n'
import { mobileCommitDropdownCopy } from './mobile-commit-dropdown-copy'
import { mobileRemoteDropdownCopy } from './mobile-remote-dropdown-copy'
import type { GitConflictOperation } from '../../../src/shared/git-status-types'
import { deriveDropdownActionContext } from '../../../src/shared/source-control-dropdown-action-context'
import { buildCommitDropdownItems } from '../../../src/shared/source-control-dropdown-commit-items'
import type { DropdownItem } from '../../../src/shared/source-control-dropdown-item-types'
import { buildRemoteDropdownItems } from '../../../src/shared/source-control-dropdown-remote-items'
import type { SourceControlCommitAreaPrimaryActionDecision } from '../../../src/shared/source-control-primary-action-decision'
import type { SourceControlPrimaryActionDecisionInputs } from '../../../src/shared/source-control-primary-action-decision-types'

// String identifiers keep native lucide imports out of this module.
export type MobileSourceControlActionIcon =
  | 'commit'
  | 'push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'publish'
  | 'rebase'
  | 'pr'
  | 'branch'
  | 'history'

export type MobileSourceControlAction = {
  id: string
  label: string
  iconKey: MobileSourceControlActionIcon
  disabled?: boolean
  hint?: string
  loading?: boolean
  skipAutoClose?: boolean
  onPress: () => void
}

export type MobileSourceControlActionArgs = {
  // The commit area's facts in desktop's shape, so rows enable and read exactly as desktop's menu.
  decision: SourceControlPrimaryActionDecisionInputs
  conflictOperation?: GitConflictOperation
  rebaseBaseRef: string | null
  busyAction: string | null
  openingPath: string | null
  openingBranchPath: string | null
  prAvailable: boolean
  prHint?: string
  forcePushBlockedReason?: string
  handlers: {
    commit: () => void
    commitPush: (forceWithLease: boolean) => void
    commitSync: () => void
    push: () => void
    forcePush: () => void
    pull: () => void
    sync: () => void
    fetch: () => void
    publish: () => void
    fastForward: () => void
    rebase: () => void
    createPr: () => void
    pushAndCreatePr: () => void
    checkout: () => void
    history: () => void
  }
}

export function buildMobileSourceControlActions(
  args: MobileSourceControlActionArgs,
  t: Translate = translate
): MobileSourceControlAction[] {
  const { handlers } = args
  const ctx = deriveDropdownActionContext({
    ...args.decision,
    conflictOperation: args.conflictOperation,
    rebaseBaseRef: args.rebaseBaseRef
  })
  const { commit, commitPush, commitSync } = buildCommitDropdownItems(
    ctx,
    mobileCommitDropdownCopy(t)
  )
  const { push, forcePush, pull, fastForward, sync, rebase, fetch, publish } =
    buildRemoteDropdownItems(ctx, mobileRemoteDropdownCopy(t))
  const busy =
    args.busyAction !== null || args.openingPath !== null || args.openingBranchPath !== null
  const blockForce = (item: DropdownItem): DropdownItem =>
    args.forcePushBlockedReason
      ? { ...item, disabled: true, title: args.forcePushBlockedReason }
      : item
  const row = (
    item: DropdownItem,
    iconKey: MobileSourceControlActionIcon,
    actionId: string,
    onPress: () => void
  ): MobileSourceControlAction => ({
    id: actionId,
    label: item.label,
    iconKey,
    disabled: busy || item.disabled,
    // Mobile has no tooltips: show why a row is disabled, and always what Force Push replaces.
    hint: item.disabled || item.kind === 'force_push' ? item.title : undefined,
    loading: args.busyAction === actionId,
    skipAutoClose: true,
    onPress
  })

  return [
    row(commit, 'commit', 'commit', handlers.commit),
    row(
      ctx.shouldForcePushWithLease ? blockForce(commitPush) : commitPush,
      'push',
      'commit-push',
      () => handlers.commitPush(ctx.shouldForcePushWithLease)
    ),
    row(commitSync, 'sync', 'commit-sync', handlers.commitSync),
    row(push, 'push', 'push', handlers.push),
    row(blockForce(forcePush), 'push', 'force-push', handlers.forcePush),
    {
      id: 'create-pr',
      label: t('sourceControl.actions.createPr', 'Create PR'),
      iconKey: 'pr',
      disabled: busy || !args.prAvailable,
      hint: args.prHint,
      loading: args.busyAction === 'create-pr',
      skipAutoClose: true,
      onPress: handlers.createPr
    },
    {
      id: 'push-create-pr',
      label: t('sourceControl.actions.pushAndCreatePr', 'Push & Create PR'),
      iconKey: 'pr',
      disabled: busy || push.disabled || !args.prAvailable,
      hint: args.prHint ?? (push.disabled ? push.title : undefined),
      loading: args.busyAction === 'push-create-pr',
      skipAutoClose: true,
      onPress: handlers.pushAndCreatePr
    },
    row(pull, 'pull', 'pull', handlers.pull),
    row(fastForward, 'pull', 'fast-forward', handlers.fastForward),
    row(sync, 'sync', 'sync', handlers.sync),
    row(rebase, 'branch', 'rebase', handlers.rebase),
    row(fetch, 'fetch', 'fetch', handlers.fetch),
    row(publish, 'publish', 'publish', handlers.publish),
    {
      id: 'checkout',
      label: t('sourceControl.actions.switchBranch', 'Switch branch'),
      iconKey: 'branch',
      disabled: busy,
      skipAutoClose: true,
      onPress: handlers.checkout
    },
    {
      id: 'history',
      label: t('sourceControl.actions.commits', 'Commits'),
      iconKey: 'history',
      disabled: busy,
      onPress: handlers.history
    }
  ]
}

export function getMobilePrimaryActionHint(
  decision: SourceControlCommitAreaPrimaryActionDecision
): string {
  switch (decision.titleIntent) {
    case 'commit_in_progress':
      return translate('sourceControl.actions.committing', 'Commit in progress.')
    case 'force_push_in_progress':
      return translate('sourceControl.actions.forcePushing', 'Force push in progress.')
    case 'action_in_progress':
    case 'remote_operation_in_progress':
      return translate(
        'sourceControl.actions.remoteOperationInProgress',
        'Remote operation in progress.'
      )
    case 'remote_operation_blocks_commit':
      return translate(
        'sourceControl.actions.waitForRemoteOperation',
        'Try again once the remote operation finishes.'
      )
    case 'resolve_conflicts_before_commit':
      return translate(
        'sourceControl.actions.resolveConflicts',
        'Resolve conflicts before committing.'
      )
    case 'commit_staged_changes':
      return translate('sourceControl.actions.commitStagedChanges', 'Commit staged changes.')
    case 'enter_commit_message':
      return translate(
        'sourceControl.actions.enterCommitMessage',
        'Enter a commit message to commit.'
      )
    case 'stage_all_changes':
      return translate('sourceControl.actions.stageAllChanges', 'Stage all changes.')
    case 'stage_file_to_commit':
      return translate(
        'sourceControl.actions.stageFileToCommit',
        'Stage at least one file to commit.'
      )
    case 'checkout_branch_before_publish':
      return translate(
        'sourceControl.actions.checkoutBeforePublish',
        'Check out a branch before publishing commits.'
      )
    case 'checking_review_status':
      return translate('sourceControl.actions.checkingReviewStatus', 'Checking review status.')
    case 'review_already_merged':
      return translate(
        'sourceControl.actions.reviewAlreadyMerged',
        'Nothing to commit. The review is already merged.'
      )
    case 'publish_branch':
      return translate('sourceControl.actions.publishToOrigin', 'Publish this branch to origin.')
    case 'push_linked_review':
      return translate(
        'sourceControl.actions.pushLinkedReview',
        'Push updates to the linked review branch.'
      )
    case 'linked_review_target_unavailable':
      return translate(
        'sourceControl.actions.linkedReviewUnavailable',
        'The linked review branch is unavailable.'
      )
    case 'force_push_with_lease':
      return translate(
        'sourceControl.actions.forcePushWithLease',
        'Force push with lease to update the remote branch.'
      )
    case 'sync_counts':
      return translate('sourceControl.actions.syncCounts', 'Pull {{behind}}, push {{ahead}}.', {
        behind: decision.behind ?? 0,
        ahead: decision.ahead ?? 0
      })
    case 'pull_count': {
      const count = decision.count ?? 0
      return count === 1
        ? translate('sourceControl.actions.pullCommits_one', 'Pull {{count}} commit.', {
            count
          })
        : translate('sourceControl.actions.pullCommits_other', 'Pull {{count}} commits.', {
            count
          })
    }
    case 'push_count': {
      const count = decision.count ?? 0
      return count === 1
        ? translate('sourceControl.actions.pushCommits_one', 'Push {{count}} commit.', {
            count
          })
        : translate('sourceControl.actions.pushCommits_other', 'Push {{count}} commits.', {
            count
          })
    }
    case 'nothing_to_commit_up_to_date':
      return translate('sourceControl.actions.upToDate', 'Nothing to commit. Branch is up to date.')
  }
}
