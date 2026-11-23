import type {
  PRReviewDecision,
  ProviderCheckSummary
} from '../../../../src/shared/github/pull-requests/pull-request-types'
import { translate } from '../../i18n/mobile-i18n'
import {
  getGitHubPRMergeChip,
  resolveGitHubPRMergeState,
  type GitHubPRMergeChipKind,
  type HostedReviewMergeTone
} from '../../../../src/shared/github/pull-requests/merge/pull-request-merge-state'
import {
  resolveGitLabMRMergeState,
  type GitLabMRMergeStateKind
} from '../../../../src/shared/gitlab/gitlab-mr-merge-state'
import type { GitHubWorkItem, GitLabWorkItem } from '../mobile-tasks-provider-detail-types'
import {
  getProviderChecksLabel,
  getProviderChecksOutcome
} from '../../../../src/shared/source-control/checks/provider-check-summary'

export type MobileHostedReviewStatus = {
  checksSummary?: ProviderCheckSummary
  reviewDecision?: string | null
  reviewRequests?: readonly unknown[]
  reviewerCount?: number
}

export function getHostedReviewLabel(item: MobileHostedReviewStatus): string {
  if (item.reviewDecision === 'approved' || item.reviewDecision === 'APPROVED') {
    return 'Approved'
  }
  if (item.reviewDecision === 'changes_requested' || item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Changes requested'
  }
  if (item.reviewDecision === 'review_required' || item.reviewDecision === 'REVIEW_REQUIRED') {
    return 'Review required'
  }
  const reviewerCount = item.reviewerCount ?? item.reviewRequests?.length
  return reviewerCount
    ? `${reviewerCount} reviewer${reviewerCount === 1 ? '' : 's'}`
    : 'No reviewers'
}

export type HostedMergeChip = { label: string; tone: HostedReviewMergeTone }

function githubReviewDecision(value: string | null | undefined): PRReviewDecision | null {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
    ? value
    : null
}

// Desktop's task page labels; draft, unknown status and passed checks stay off the row, which already shows them.
function githubMergeChipLabel(kind: GitHubPRMergeChipKind): string | null {
  switch (kind) {
    case 'merged':
      return translate('auto.components.github.pr.merge.state.83ecdbb4a6', 'Merged')
    case 'closed':
      return translate('auto.components.github.pr.merge.state.4f976d3450', 'Closed')
    case 'review_required':
      return translate('auto.components.github.pr.merge.state.1f8eb81c0e', 'Approval required')
    case 'changes_requested':
      return translate('auto.components.github.pr.merge.state.c606463dc2', 'Changes requested')
    case 'conflicts':
      return translate('auto.components.github.pr.merge.state.7e8bbe3cd7', 'Conflicts')
    case 'merge_queue':
      return translate('auto.components.github.pr.merge.state.b169f943e1', 'Merge when ready')
    case 'merge_queue_auto_merge_on':
      return translate('auto.components.github.pr.merge.state.autoMergeOn', 'Auto-merge on')
    case 'behind':
      return translate('auto.components.github.pr.merge.state.039c072f94', 'Behind')
    case 'blocked':
      return translate('auto.components.github.pr.merge.state.bf5e4c6c92', 'Blocked')
    case 'checks_cancelled':
      return translate('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
    case 'mergeable_checks_failed':
      return translate('auto.components.github.pr.merge.state.87fa36ac83', 'Checks failed')
    case 'mergeable_checks_pending':
      return translate('auto.components.github.pr.merge.state.4e2507176b', 'Checks pending')
    case 'mergeable_checks_passed':
    case 'mergeable':
      return translate('auto.components.github.pr.merge.state.def355ff38', 'Able to merge')
    case 'checking':
      return translate('auto.components.github.pr.merge.state.f958920f3a', 'Checking')
    case 'draft':
    case 'merge_status_unavailable':
    case 'checks_passed':
      return null
  }
}

export function getGitHubMergeChip(item: GitHubWorkItem): HostedMergeChip | null {
  const input = { ...item, reviewDecision: githubReviewDecision(item.reviewDecision) }
  const chip = getGitHubPRMergeChip(resolveGitHubPRMergeState(input).kind, input)
  const label = githubMergeChipLabel(chip.kind)
  return label === null ? null : { label, tone: chip.tone }
}

function gitlabMergeChip(kind: GitLabMRMergeStateKind): HostedMergeChip | null {
  switch (kind) {
    case 'merged':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.fae95ae20d',
          'Merged'
        ),
        tone: 'neutral'
      }
    case 'closed':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.88d044c42f',
          'Closed'
        ),
        tone: 'danger'
      }
    case 'conflicts':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.96b05e374c',
          'Conflicts'
        ),
        tone: 'danger'
      }
    case 'approval_required':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.5105b0e584',
          'Approval required'
        ),
        tone: 'warning'
      }
    case 'changes_requested':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.893a999c8c',
          'Changes requested'
        ),
        tone: 'danger'
      }
    case 'unresolved_threads':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.01ab632a21',
          'Unresolved threads'
        ),
        tone: 'warning'
      }
    case 'checks_must_pass':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.bf628700f6',
          'Checks must pass'
        ),
        tone: 'warning'
      }
    case 'checks_running':
    case 'mergeable_checks_pending':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.65c847ad1e',
          'Checks pending'
        ),
        tone: 'warning'
      }
    case 'behind':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.382c70faeb',
          'Behind'
        ),
        tone: 'warning'
      }
    case 'checking':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.195917574e',
          'Checking'
        ),
        tone: 'neutral'
      }
    case 'blocked':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.4ecc0d90ee',
          'Blocked'
        ),
        tone: 'danger'
      }
    case 'mergeable_checks_failed':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.49ac4fec10',
          'Checks failed'
        ),
        tone: 'danger'
      }
    case 'mergeable':
      return {
        label: translate(
          'auto.components.right.sidebar.gitlab.mr.merge.state.04a3015a12',
          'Able to merge'
        ),
        tone: 'success'
      }
    // List reads carry no detailed merge status, so GitLab never reported why the MR can't merge yet.
    case 'unreported':
    case 'unreported_checks_failed':
    case 'draft':
      return null
  }
}

export function getGitLabMergeChip(item: GitLabWorkItem): HostedMergeChip | null {
  const checks = item.checksSummary?.state
  return gitlabMergeChip(
    resolveGitLabMRMergeState({
      state:
        item.state === 'merged' || item.state === 'closed' || item.state === 'draft'
          ? item.state
          : 'open',
      status: checks === undefined || checks === 'none' ? 'neutral' : checks,
      mergeable: item.mergeable
    }).kind
  )
}

export function getHostedChecksLabel(item: { checksSummary?: ProviderCheckSummary }): string {
  return getProviderChecksOutcome(item.checksSummary) === 'cancelled'
    ? translate('pullRequest.checkStatus.cancelled', 'Cancelled')
    : getProviderChecksLabel(item.checksSummary)
}

export function getHostedReviewSignalTone(
  item: MobileHostedReviewStatus,
  signal: 'review' | 'checks'
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (signal === 'review') {
    if (item.reviewDecision === 'approved' || item.reviewDecision === 'APPROVED') {
      return 'success'
    }
    if (
      item.reviewDecision === 'changes_requested' ||
      item.reviewDecision === 'CHANGES_REQUESTED'
    ) {
      return 'danger'
    }
    if (
      item.reviewDecision === 'review_required' ||
      item.reviewDecision === 'REVIEW_REQUIRED' ||
      item.reviewerCount !== undefined ||
      item.reviewRequests?.length
    ) {
      return 'warning'
    }
    return 'neutral'
  }
  if (getProviderChecksOutcome(item.checksSummary) === 'success') {
    return 'success'
  }
  if (getProviderChecksOutcome(item.checksSummary) === 'failure') {
    return 'danger'
  }
  if (getProviderChecksOutcome(item.checksSummary) === 'pending') {
    return 'warning'
  }
  return 'neutral'
}
