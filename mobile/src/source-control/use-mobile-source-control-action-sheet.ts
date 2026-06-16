import { useMemo } from 'react'
import { buildMobileSourceControlActions } from './mobile-source-control-actions'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { SOURCE_CONTROL_ACTION_ICONS } from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'

// Builds the bottom action-sheet entries from the source-control state. Kept
// out of the panel component so the giant action map doesn't bloat the view.
export function useMobileSourceControlActionSheet(
  state: MobileSourceControlState
): ActionSheetAction[] {
  const {
    commitMessage,
    stagedCount,
    upstream,
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
    openPrSheet,
    openBranchPicker,
    openHistory
  } = state

  return useMemo<ActionSheetAction[]>(
    () =>
      buildMobileSourceControlActions({
        commitMessage,
        stagedCount,
        upstream: upstream ?? null,
        upstreamKnown,
        busyAction,
        openingPath,
        openingBranchPath,
        prAvailable: upstreamKnown && upstream?.hasUpstream === true,
        handlers: {
          commit: () => void runActionSheetCommit(),
          commitPush: () =>
            void runActionSheetCommitSequence('commit-push', [{ method: 'git.push' }]),
          commitSync: () => void runActionSheetCommitSync(),
          push: () => void runActionSheetGitSequence('push', [{ method: 'git.push' }]),
          pull: () => void runActionSheetGitSequence('pull', [{ method: 'git.pull' }]),
          sync: () => void runActionSheetGitSync(),
          fetch: () => void runActionSheetGitSequence('fetch', [{ method: 'git.fetch' }]),
          publish: () =>
            void runActionSheetGitSequence('publish', [
              { method: 'git.push', params: { publish: true } }
            ]),
          fastForward: () =>
            void runActionSheetGitSequence('fast-forward', [{ method: 'git.fastForward' }]),
          rebase: () => void runActionSheetRebase(),
          createPr: () => void openPrSheet(false),
          pushAndCreatePr: () => void openPrSheet(true),
          checkout: () => void openBranchPicker(),
          history: () => void openHistory()
        }
      }).map((action) => ({ ...action, icon: SOURCE_CONTROL_ACTION_ICONS[action.iconKey] })),
    [
      busyAction,
      commitMessage,
      openBranchPicker,
      openHistory,
      openingBranchPath,
      openingPath,
      openPrSheet,
      runActionSheetCommit,
      runActionSheetCommitSequence,
      runActionSheetCommitSync,
      runActionSheetGitSequence,
      runActionSheetGitSync,
      runActionSheetRebase,
      stagedCount,
      upstream,
      upstreamKnown
    ]
  )
}
