import { useMemo } from 'react'
import { buildMobileCreatePrAction } from './mobile-create-pr-action'
import { useMobileHostedReviewEligibility } from './use-mobile-hosted-review-eligibility'
import {
  getMobileBranchCommitsAhead,
  type MobileSourceControlPrimaryActionArgs
} from './mobile-source-control-primary-action'

type Params = {
  client: Parameters<typeof useMobileHostedReviewEligibility>[0]['client']
  connState: Parameters<typeof useMobileHostedReviewEligibility>[0]['connState']
  hostId: string
  worktreeId: string
  // The commit area's inputs also decide whether Create PR can prepare the branch first.
  commitArea: MobileSourceControlPrimaryActionArgs
  createPr: (pushFirst: boolean) => void
}

export function useMobileSourceControlCreatePrAction({
  client,
  connState,
  hostId,
  worktreeId,
  commitArea,
  createPr
}: Params) {
  const { status, busyAction } = commitArea
  const upstream = status?.upstreamStatus
  const eligibilityState = useMobileHostedReviewEligibility({
    client,
    connState,
    hostId,
    worktreeId,
    branch: status?.branch,
    hasUpstream: upstream?.hasUpstream,
    ahead: upstream?.ahead,
    behind: upstream?.behind,
    hasUncommittedChanges: (status?.entries.length ?? 0) > 0
  })

  return useMemo(
    () =>
      buildMobileCreatePrAction({
        branch: status?.branch,
        eligibilityState,
        busyAction,
        prepareInputs: {
          stagedCount: commitArea.stagedCount,
          hasStageableChanges: commitArea.stageablePaths.length > 0,
          hasMessage: commitArea.commitMessage.trim().length > 0,
          hasUnresolvedConflicts: commitArea.hasUnresolvedConflicts,
          upstreamStatus: upstream,
          branchCommitsAhead: getMobileBranchCommitsAhead(commitArea)
        },
        onCreatePr: createPr
      }),
    [busyAction, commitArea, createPr, eligibilityState, status?.branch, upstream]
  )
}
