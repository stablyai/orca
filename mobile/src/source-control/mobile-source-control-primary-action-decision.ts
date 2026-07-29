import type { MobileGitUpstreamStatus } from './mobile-git-status'

export type MobileSourceControlPrimaryActionKind =
  | 'commit'
  | 'stage'
  | 'push'
  | 'pull'
  | 'sync'
  | 'publish'

export type MobileSourceControlRemoteOpKind =
  | 'push'
  | 'force_push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'fast_forward'
  | 'publish'
  | 'rebase'

export type MobileSourceControlPrimaryActionTitleIntent =
  | 'commit_in_progress'
  | 'force_push_in_progress'
  | 'action_in_progress'
  | 'remote_operation_in_progress'
  | 'remote_operation_blocks_commit'
  | 'resolve_conflicts_before_commit'
  | 'commit_staged_changes'
  | 'enter_commit_message'
  | 'stage_all_changes'
  | 'stage_file_to_commit'
  | 'checkout_branch_before_publish'
  | 'publish_branch'
  | 'force_push_with_lease'
  | 'sync_counts'
  | 'pull_count'
  | 'push_count'
  | 'nothing_to_commit_up_to_date'

export type MobileSourceControlPrimaryActionDecision = {
  kind: MobileSourceControlPrimaryActionKind
  disabled: boolean
  labelIntent: MobileSourceControlPrimaryActionKind | 'force_push'
  titleIntent: MobileSourceControlPrimaryActionTitleIntent
  count?: number
  ahead?: number
  behind?: number
  upstreamName?: string
  requiresForceWithLease?: boolean
}

export type MobileSourceControlPrimaryActionDecisionInputs = {
  stagedCount: number
  hasUnstagedChanges: boolean
  hasStageableChanges: boolean
  hasPartiallyStagedChanges: boolean
  hasMessage: boolean
  hasUnresolvedConflicts: boolean
  isCommitting: boolean
  isRemoteOperationActive: boolean
  upstreamStatus: MobileGitUpstreamStatus | undefined
  inFlightRemoteOpKind?: MobileSourceControlRemoteOpKind | null
  branchCommitsAhead?: number
  hasCurrentBranch?: boolean
}

// Why: Metro cannot load runtime modules from the desktop/root `src/shared`
// tree. Keep this mobile mirror narrow and parity-tested against the shared
// commit-area decision core so the semantic ladder cannot drift silently.
export function resolveMobileSourceControlCommitAreaPrimaryActionDecision(
  inputs: MobileSourceControlPrimaryActionDecisionInputs
): MobileSourceControlPrimaryActionDecision {
  const {
    stagedCount,
    hasUnstagedChanges,
    hasStageableChanges,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus,
    branchCommitsAhead,
    hasCurrentBranch = true
  } = inputs

  if (isCommitting) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'commit_in_progress',
      disabled: true
    }
  }

  if (isRemoteOperationActive) {
    return resolveMobilePrimaryActionDuringRemoteOp(inputs)
  }

  if (hasUnresolvedConflicts) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'resolve_conflicts_before_commit',
      disabled: true
    }
  }

  const hasStaged = stagedCount > 0

  if (hasStaged && hasMessage) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'commit_staged_changes',
      disabled: false
    }
  }

  if (hasStaged && !hasMessage) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'enter_commit_message',
      disabled: true
    }
  }

  if (!hasStaged && hasStageableChanges) {
    return {
      kind: 'stage',
      labelIntent: 'stage',
      titleIntent: 'stage_all_changes',
      disabled: false
    }
  }

  if (!upstreamStatus) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'stage_file_to_commit',
      disabled: true
    }
  }

  if (!upstreamStatus.hasUpstream) {
    if (!hasCurrentBranch) {
      return {
        kind: 'commit',
        labelIntent: 'commit',
        titleIntent: 'checkout_branch_before_publish',
        disabled: true
      }
    }
    return {
      kind: 'publish',
      labelIntent: 'publish',
      titleIntent: 'publish_branch',
      disabled: false
    }
  }

  if (upstreamStatus.ahead > 0 && upstreamStatus.behind > 0) {
    if (shouldForcePushWithLeaseForMobileUpstream(upstreamStatus)) {
      return {
        kind: 'push',
        labelIntent: 'force_push',
        titleIntent: 'force_push_with_lease',
        disabled: false,
        count: branchCommitsAhead,
        upstreamName: upstreamStatus.upstreamName,
        requiresForceWithLease: true
      }
    }
    return {
      kind: 'sync',
      labelIntent: 'sync',
      titleIntent: 'sync_counts',
      disabled: false,
      ahead: upstreamStatus.ahead,
      behind: upstreamStatus.behind
    }
  }

  if (upstreamStatus.behind > 0) {
    return {
      kind: 'pull',
      labelIntent: 'pull',
      titleIntent: 'pull_count',
      disabled: false,
      count: upstreamStatus.behind
    }
  }

  if (upstreamStatus.ahead > 0) {
    return {
      kind: 'push',
      labelIntent: 'push',
      titleIntent: 'push_count',
      disabled: false,
      count: upstreamStatus.ahead
    }
  }

  return {
    kind: 'commit',
    labelIntent: 'commit',
    titleIntent: hasUnstagedChanges ? 'stage_file_to_commit' : 'nothing_to_commit_up_to_date',
    disabled: true
  }
}

function resolveMobilePrimaryActionDuringRemoteOp(
  inputs: MobileSourceControlPrimaryActionDecisionInputs
): MobileSourceControlPrimaryActionDecision {
  const { inFlightRemoteOpKind, hasUnresolvedConflicts } = inputs
  const candidate = resolveMobileSourceControlCommitAreaPrimaryActionDecision({
    ...inputs,
    isRemoteOperationActive: false
  })
  const inFlightIsPrimaryKind =
    inFlightRemoteOpKind === 'push' ||
    inFlightRemoteOpKind === 'pull' ||
    inFlightRemoteOpKind === 'sync' ||
    inFlightRemoteOpKind === 'publish'

  if (inFlightRemoteOpKind === 'force_push') {
    return {
      kind: 'push',
      labelIntent: 'force_push',
      titleIntent: 'force_push_in_progress',
      disabled: true,
      requiresForceWithLease: true
    }
  }

  if (inFlightIsPrimaryKind && candidate.kind !== inFlightRemoteOpKind) {
    return {
      kind: inFlightRemoteOpKind,
      labelIntent: inFlightRemoteOpKind,
      titleIntent: 'action_in_progress',
      disabled: true
    }
  }

  const titleIntent = hasUnresolvedConflicts
    ? 'resolve_conflicts_before_commit'
    : candidate.kind === 'commit'
      ? 'remote_operation_blocks_commit'
      : 'remote_operation_in_progress'

  return {
    ...candidate,
    titleIntent,
    disabled: true
  }
}

function shouldForcePushWithLeaseForMobileUpstream(
  status: MobileGitUpstreamStatus | undefined
): boolean {
  return (
    status?.hasUpstream === true &&
    status.ahead > 0 &&
    status.behind > 0 &&
    status.behindCommitsArePatchEquivalent === true
  )
}
