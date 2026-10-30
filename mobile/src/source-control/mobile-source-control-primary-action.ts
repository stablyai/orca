import { translate } from '../i18n/mobile-i18n'
import { getMobilePrimaryActionHint } from './mobile-source-control-actions'
import { getMobileForcePushBlockedReason } from './mobile-source-control-review-copy'
import type { SourceControlPrimaryActionDecisionInputs } from '../../../src/shared/source-control-primary-action-decision-types'
import {
  resolveSourceControlCommitAreaPrimaryActionDecision,
  type SourceControlCommitAreaPrimaryActionDecision,
  type SourceControlRemoteOpKind
} from '../../../src/shared/source-control-primary-action-decision'
import {
  hasResolvableHostedReviewPushTargetLink,
  resolveHostedReviewPushTargetForActions
} from '../../../src/shared/hosted-review-push-target'
import type { PRState } from '../../../src/shared/github/pull-request-types'
import type { GitPushTarget } from '../../../src/shared/worktree/types'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import type { MobileGitBranchCompareResult } from './mobile-branch-compare'
import type { MobileGitStatusResult } from './mobile-git-status'

export { getMobileForcePushBlockedReason } from './mobile-source-control-review-copy'

type GitStep = { method: string; params?: Record<string, unknown> }

type MobileSourceControlPrimaryActionKind = SourceControlCommitAreaPrimaryActionDecision['kind']
type MobileSourceControlPrimaryActionDecision = SourceControlCommitAreaPrimaryActionDecision
type MobileSourceControlRemoteOpKind = SourceControlRemoteOpKind

export type MobileSourceControlPrimaryAction = {
  kind: MobileSourceControlPrimaryActionKind
  label: string
  accessibilityLabel: string
  accessibilityHint: string
  disabled: boolean
  loading: boolean
  requiresForceWithLease?: boolean
  onPress: () => void
}

export type MobileSourceControlPrimaryActionHandlers = {
  commit: () => Promise<boolean>
  stageAll: () => Promise<void>
  runActionSheetGitSequence: (actionId: string, steps: GitStep[]) => Promise<void>
  runActionSheetGitSync: () => Promise<void>
}

// The branch's review as the PR panel loaded it; desktop's commit area reads the same facts.
export type MobileSourceControlReviewInputs = {
  prState: PRState | null
  isPRStateLoading: boolean
  reviewNumber: number | null
  pushTarget: GitPushTarget | null
}

const NO_REVIEW: MobileSourceControlReviewInputs = {
  prState: null,
  isPRStateLoading: false,
  reviewNumber: null,
  pushTarget: null
}

export function resolveMobileSourceControlReviewInputs(
  state: PrSidebarState
): MobileSourceControlReviewInputs {
  if (state.kind === 'ready') {
    return {
      prState: state.data.pr.state,
      isPRStateLoading: false,
      reviewNumber: state.data.pr.number,
      pushTarget: state.data.pushTarget
    }
  }
  return state.kind === 'loading' ? { ...NO_REVIEW, isPRStateLoading: true } : NO_REVIEW
}

export type MobileSourceControlPrimaryActionArgs = {
  status: MobileGitStatusResult | null
  hasUnresolvedConflicts: boolean
  stageablePaths: readonly string[]
  stagedCount: number
  unstagedCount: number
  commitMessage: string
  busyAction: string | null
  openingPath: string | null
  openingBranchPath: string | null
  branchCompareResult: MobileGitBranchCompareResult | null
  review?: MobileSourceControlReviewInputs
  handlers: MobileSourceControlPrimaryActionHandlers
}

// The commit area's facts in desktop's decision shape; the primary action and the action sheet both read them.
export function buildMobileSourceControlDecisionInputs(
  args: Omit<MobileSourceControlPrimaryActionArgs, 'handlers'>
): SourceControlPrimaryActionDecisionInputs {
  const review = args.review ?? NO_REVIEW
  // Mobile reads upstream status untargeted, so a review with its own push target (fork checkouts) is not gated here.
  const hasReviewLink =
    review.pushTarget === null &&
    hasResolvableHostedReviewPushTargetLink({ linkedGitHubPR: review.reviewNumber })
  const reviewTarget = resolveHostedReviewPushTargetForActions({
    hasHostedReviewLink: hasReviewLink,
    hasResolvableHostedReviewPushTargetLink: hasReviewLink,
    hostedReviewState: review.prState,
    isHostedReviewStateLoading: review.isPRStateLoading,
    upstreamStatus: args.status?.upstreamStatus,
    branchName: args.status?.branch?.replace(/^refs\/heads\//, '')
  })
  return {
    stagedCount: args.stagedCount,
    hasUnstagedChanges: args.unstagedCount > 0,
    hasStageableChanges: args.stageablePaths.length > 0,
    // Partial staging affects commit eligibility, not this area decision; avoid another entry scan.
    hasPartiallyStagedChanges: false,
    hasMessage: args.commitMessage.trim().length > 0,
    hasUnresolvedConflicts: args.hasUnresolvedConflicts,
    isCommitting: args.busyAction === 'commit',
    isRemoteOperationActive: isMobileRemoteOperationActive(args.busyAction),
    inFlightRemoteOpKind: getInFlightRemoteOpKind(args.busyAction),
    upstreamStatus: reviewTarget.upstreamStatusForActions,
    branchCommitsAhead: getMobileBranchCommitsAhead(args),
    hasCurrentBranch: Boolean(args.status?.branch),
    prState: reviewTarget.hostedReviewStateForActions,
    isPRStateLoading: review.isPRStateLoading,
    canPushLinkedReviewWithoutUpstream: reviewTarget.canUseHostedReviewPushTarget
  }
}

export function buildMobileSourceControlPrimaryAction(
  args: MobileSourceControlPrimaryActionArgs
): MobileSourceControlPrimaryAction {
  const decision = resolveSourceControlCommitAreaPrimaryActionDecision(
    buildMobileSourceControlDecisionInputs(args)
  )
  const ioBusy =
    args.busyAction !== null || args.openingPath !== null || args.openingBranchPath !== null
  const forcePushBlockedReason = decision.requiresForceWithLease
    ? getMobileForcePushBlockedReason(args.review)
    : undefined
  const disabled = decision.disabled || ioBusy || forcePushBlockedReason !== undefined

  return {
    kind: decision.kind,
    label: getMobilePrimaryActionLabel(decision),
    accessibilityLabel: getMobilePrimaryActionLabel(decision),
    accessibilityHint: forcePushBlockedReason ?? getMobilePrimaryActionHint(decision),
    disabled,
    loading: isLoadingDecision(decision, args.busyAction),
    requiresForceWithLease: decision.requiresForceWithLease,
    onPress: () => {
      if (disabled) {
        return
      }
      void runMobilePrimaryAction(decision, args.handlers)
    }
  }
}

function isMobileRemoteOperationActive(busyAction: string | null): boolean {
  return getInFlightRemoteOpKind(busyAction) !== null
}

function getInFlightRemoteOpKind(
  busyAction: string | null
): MobileSourceControlRemoteOpKind | null {
  switch (busyAction) {
    case 'push':
    case 'commit-push':
    case 'push-create-pr':
      return 'push'
    case 'force-push':
      return 'force_push'
    case 'pull':
      return 'pull'
    case 'sync':
    case 'commit-sync':
      return 'sync'
    case 'fetch':
      return 'fetch'
    case 'publish':
      return 'publish'
    case 'fast-forward':
      return 'fast_forward'
    case 'rebase':
      return 'rebase'
    default:
      return null
  }
}

export function getMobileBranchCommitsAhead(
  args: Pick<MobileSourceControlPrimaryActionArgs, 'branchCompareResult' | 'status'>
): number | undefined {
  const summary = args.branchCompareResult?.summary
  if (summary?.status === 'ready' && summary.commitsAhead !== undefined) {
    return summary.commitsAhead
  }
  const upstream = args.status?.upstreamStatus
  return upstream?.hasUpstream ? upstream.ahead : undefined
}

function getMobilePrimaryActionLabel(decision: MobileSourceControlPrimaryActionDecision): string {
  if (decision.requiresForceWithLease) {
    return translate('sourceControl.primaryAction.forcePush', 'Force Push')
  }
  switch (decision.kind) {
    case 'commit':
      return translate('sourceControl.primaryAction.commit', 'Commit')
    case 'stage':
      return translate('sourceControl.primaryAction.stageAll', 'Stage All')
    case 'push':
      return translate('sourceControl.primaryAction.push', 'Push')
    case 'pull':
      return translate('sourceControl.primaryAction.pull', 'Pull')
    case 'sync':
      return translate('sourceControl.primaryAction.sync', 'Sync')
    case 'publish':
      return translate('sourceControl.primaryAction.publishBranch', 'Publish Branch')
  }
}

function isLoadingDecision(
  decision: MobileSourceControlPrimaryActionDecision,
  busyAction: string | null
): boolean {
  switch (decision.kind) {
    case 'commit':
      return busyAction === 'commit'
    case 'stage':
      return busyAction === 'stage-all'
    case 'push':
      return (
        busyAction === 'push' ||
        busyAction === 'force-push' ||
        busyAction === 'commit-push' ||
        busyAction === 'push-create-pr'
      )
    case 'pull':
      return busyAction === 'pull'
    case 'sync':
      return busyAction === 'sync' || busyAction === 'commit-sync'
    case 'publish':
      return busyAction === 'publish'
  }
}

async function runMobilePrimaryAction(
  decision: MobileSourceControlPrimaryActionDecision,
  handlers: MobileSourceControlPrimaryActionHandlers
): Promise<void> {
  switch (decision.kind) {
    case 'commit':
      await handlers.commit()
      return
    case 'stage':
      await handlers.stageAll()
      return
    case 'push': {
      const params = decision.requiresForceWithLease ? { forceWithLease: true } : undefined
      await handlers.runActionSheetGitSequence(
        decision.requiresForceWithLease ? 'force-push' : 'push',
        [{ method: 'git.push', params }]
      )
      return
    }
    case 'pull':
      await handlers.runActionSheetGitSequence('pull', [{ method: 'git.pull' }])
      return
    case 'sync':
      await handlers.runActionSheetGitSync()
      return
    case 'publish':
      await handlers.runActionSheetGitSequence('publish', [
        { method: 'git.push', params: { publish: true } }
      ])
      return
  }
}
