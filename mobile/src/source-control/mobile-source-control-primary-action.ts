import {
  resolveMobileSourceControlCommitAreaPrimaryActionDecision,
  type MobileSourceControlPrimaryActionDecision,
  type MobileSourceControlPrimaryActionKind,
  type MobileSourceControlRemoteOpKind
} from './mobile-source-control-primary-action-decision'
import type { MobileGitBranchCompareResult } from './mobile-branch-compare'
import type { MobileGitStatusResult } from './mobile-git-status'
import { t } from '@/i18n/mobile-i18n'

type GitStep = { method: string; params?: Record<string, unknown> }

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
  handlers: MobileSourceControlPrimaryActionHandlers
}

export function buildMobileSourceControlPrimaryAction(
  args: MobileSourceControlPrimaryActionArgs
): MobileSourceControlPrimaryAction {
  const decision = resolveMobileSourceControlCommitAreaPrimaryActionDecision({
    stagedCount: args.stagedCount,
    hasUnstagedChanges: args.unstagedCount > 0,
    hasStageableChanges: args.stageablePaths.length > 0,
    // Why: the commit-area decision keeps the desktop input shape, but partial
    // staging only matters to commit eligibility/dropdowns. Avoid an extra entry scan.
    hasPartiallyStagedChanges: false,
    hasMessage: args.commitMessage.trim().length > 0,
    hasUnresolvedConflicts: args.hasUnresolvedConflicts,
    isCommitting: args.busyAction === 'commit',
    isRemoteOperationActive: isMobileRemoteOperationActive(args.busyAction),
    inFlightRemoteOpKind: getInFlightRemoteOpKind(args.busyAction),
    upstreamStatus: args.status?.upstreamStatus,
    branchCommitsAhead: getMobileBranchCommitsAhead(args),
    hasCurrentBranch: Boolean(args.status?.branch)
  })
  const ioBusy =
    args.busyAction !== null || args.openingPath !== null || args.openingBranchPath !== null
  const disabled = decision.disabled || ioBusy

  return {
    kind: decision.kind,
    label: getMobilePrimaryActionLabel(decision),
    accessibilityLabel: getMobilePrimaryActionLabel(decision),
    accessibilityHint: getMobilePrimaryActionHint(decision),
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

function getMobileBranchCommitsAhead(
  args: MobileSourceControlPrimaryActionArgs
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
    return t('mobileSourceControlPrimaryAction.forcePush')
  }
  switch (decision.kind) {
    case 'commit':
      return t('mobileSourceControlPrimaryAction.commit')
    case 'stage':
      return t('mobileSourceControlPrimaryAction.stageAll')
    case 'push':
      return t('mobileSourceControlPrimaryAction.push')
    case 'pull':
      return t('mobileSourceControlPrimaryAction.pull')
    case 'sync':
      return t('mobileSourceControlPrimaryAction.sync')
    case 'publish':
      return t('mobileSourceControlPrimaryAction.publishBranch')
  }
}

function getMobilePrimaryActionHint(decision: MobileSourceControlPrimaryActionDecision): string {
  switch (decision.titleIntent) {
    case 'commit_in_progress':
      return t('mobileSourceControlPrimaryAction.commitProgress')
    case 'force_push_in_progress':
      return t('mobileSourceControlPrimaryAction.forcePushProgress')
    case 'action_in_progress':
    case 'remote_operation_in_progress':
      return t('mobileSourceControlPrimaryAction.remote')
    case 'remote_operation_blocks_commit':
      return t('mobileSourceControlPrimaryAction.try')
    case 'resolve_conflicts_before_commit':
      return t('mobileSourceControlPrimaryAction.resolve')
    case 'commit_staged_changes':
      return t('mobileSourceControlPrimaryAction.commitStaged')
    case 'enter_commit_message':
      return t('mobileSourceControlPrimaryAction.enter')
    case 'stage_all_changes':
      return t('mobileSourceControlPrimaryAction.stageAllChanges')
    case 'stage_file_to_commit':
      return t('mobileSourceControlPrimaryAction.stageLeast')
    case 'checkout_branch_before_publish':
      return t('mobileSourceControlPrimaryAction.check')
    case 'publish_branch':
      return t('mobileSourceControlPrimaryAction.publishBranchOrigin')
    case 'force_push_with_lease':
      return t('mobileSourceControlPrimaryAction.forcePushLease')
    case 'sync_counts':
      return t('mobileSourceControlPrimaryAction.pullBehind', {
        behindCommitCount: decision.behind ?? 0,
        aheadCommitCount: decision.ahead ?? 0
      })
    case 'pull_count':
      return t(
        decision.count === 1
          ? 'mobileSourceControlPrimaryAction.pullCommitCountCommit'
          : 'mobileSourceControlPrimaryAction.pullCommitCountCommits',
        {
          commitCount: decision.count ?? 0
        }
      )
    case 'push_count':
      return t(
        decision.count === 1
          ? 'mobileSourceControlPrimaryAction.pushCommitCountCommit'
          : 'mobileSourceControlPrimaryAction.pushCommitCountCommits',
        {
          commitCount: decision.count ?? 0
        }
      )
    case 'nothing_to_commit_up_to_date':
      return t('mobileSourceControlPrimaryAction.nothing')
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
