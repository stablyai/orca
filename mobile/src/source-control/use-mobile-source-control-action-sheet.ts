import { useMemo } from 'react'
import { mobileCommitDropdownCopy } from './mobile-commit-dropdown-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { buildMobileSourceControlActions } from './mobile-source-control-actions'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { SOURCE_CONTROL_ACTION_ICONS } from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import {
  buildMobileSourceControlDecisionInputs,
  getMobileForcePushBlockedReason,
  type MobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'

export function useMobileSourceControlActionSheet(
  state: MobileSourceControlState,
  review: MobileSourceControlReviewInputs
): ActionSheetAction[] {
  const t = useMobileTranslation()
  const {
    primaryActionArgs,
    status,
    rebaseBaseRef,
    upstreamKnown,
    busyAction,
    openingPath,
    openingBranchPath,
    runActionSheetCommit,
    runActionSheetCommitSequence,
    runActionSheetCommitSync,
    runActionSheetGitSequence,
    runActionSheetGitSync,
    runActionSheetRebase,
    createPr,
    openBranchPicker,
    openHistory
  } = state

  return useMemo<ActionSheetAction[]>(
    () =>
      buildMobileSourceControlActions(
        {
          decision: buildMobileSourceControlDecisionInputs({ ...primaryActionArgs, review }),
          conflictOperation: status?.conflictOperation,
          // Desktop rebases onto the effective base, not an upstream compare base.
          rebaseBaseRef,
          busyAction,
          openingPath,
          openingBranchPath,
          // Create intent may publish or push before review creation.
          prAvailable: upstreamKnown,
          prHint: upstreamKnown ? undefined : mobileCommitDropdownCopy(t).checkingBranchStatus,
          forcePushBlockedReason: getMobileForcePushBlockedReason(review),
          handlers: {
            commit: () => void runActionSheetCommit(),
            commitPush: (forceWithLease) =>
              void runActionSheetCommitSequence('commit-push', [
                forceWithLease
                  ? { method: 'git.push', params: { forceWithLease: true } }
                  : { method: 'git.push' }
              ]),
            commitSync: () => void runActionSheetCommitSync(),
            push: () => void runActionSheetGitSequence('push', [{ method: 'git.push' }]),
            forcePush: () =>
              void runActionSheetGitSequence('force-push', [
                { method: 'git.push', params: { forceWithLease: true } }
              ]),
            pull: () => void runActionSheetGitSequence('pull', [{ method: 'git.pull' }]),
            sync: () => void runActionSheetGitSync(),
            fetch: () => void runActionSheetGitSequence('fetch', [{ method: 'git.fetch' }]),
            publish: () =>
              void runActionSheetGitSequence('publish', [
                { method: 'git.push', params: { publish: true } }
              ]),
            fastForward: () =>
              void runActionSheetGitSequence('fast-forward', [{ method: 'git.fastForward' }]),
            rebase: () => void runActionSheetRebase(rebaseBaseRef),
            createPr: () => void createPr(false),
            pushAndCreatePr: () => void createPr(true),
            checkout: () => void openBranchPicker(),
            history: () => void openHistory()
          }
        },
        t
      ).map((action) => ({ ...action, icon: SOURCE_CONTROL_ACTION_ICONS[action.iconKey] })),
    [
      busyAction,
      createPr,
      openBranchPicker,
      openHistory,
      openingBranchPath,
      openingPath,
      primaryActionArgs,
      rebaseBaseRef,
      review,
      runActionSheetCommit,
      runActionSheetCommitSequence,
      runActionSheetCommitSync,
      runActionSheetGitSequence,
      runActionSheetGitSync,
      runActionSheetRebase,
      status?.conflictOperation,
      upstreamKnown,
      t
    ]
  )
}
