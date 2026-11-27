import { isCompletePRCheckOwner } from '../../../../../../src/shared/github/checks/complete-pr-check-owner'
import { getProviderChecksOutcome } from '../../../../../../src/shared/source-control/checks/provider-check-summary'
import type { PRCheckDetail } from '../../../../../../src/shared/github/checks/check-types'
import type { PRInfo } from '../../../../../../src/shared/github/pull-requests/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../../../src/shared/github/work-items/work-item-types'
import { groupPRComments } from '../../../../../../src/shared/source-control/review-comments/pr-comment-groups'
import { isBotPRComment } from '../../../../../../src/shared/source-control/review-comments/pr-comment-audience'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { isPrSidebarDetailsPlaceholder } from '../mobile-pr-sidebar-state'
import { checkOutcome, summarizePRChecks } from '../checks/pr-checks-presentation'

// passed: green check. blocking: red. waiting: amber. idle: muted, nothing to do. loading: spinner.
export type PrGateTone = 'passed' | 'blocking' | 'waiting' | 'idle' | 'loading'
export type PrGateTarget = 'checks' | 'comments' | 'reviewers' | null

export type PrGateRow = {
  key: 'checks' | 'threads' | 'approvals' | 'conflicts'
  tone: PrGateTone
  title: string
  subtitle: string | null
  /** The screen or sheet that resolves this gate; null rows do not navigate. */
  target: PrGateTarget
}

type GateInput = {
  pr: PRInfo
  details: GitHubWorkItemDetails | null
  checks: PRCheckDetail[]
  checksError: string | null
  botAuthorOverrides?: ReadonlySet<string>
}

export function buildPrGateRows(input: GateInput, t: Translate): PrGateRow[] {
  const details =
    input.details && !isPrSidebarDetailsPlaceholder(input.details) ? input.details : null
  // Null details means still loading; a placeholder means the read failed.
  const detailsLoading = input.details === null
  return [
    checksGate(input, t),
    threadsGate(details, detailsLoading, t, input.botAuthorOverrides),
    approvalsGate(input.pr, details, detailsLoading, t),
    conflictsGate(input.pr, details?.item.baseRefName ?? null, t)
  ]
}

function checksGate({ checks, checksError, pr }: GateInput, t: Translate): PrGateRow {
  const base = { key: 'checks', target: 'checks' } as const
  const complete = isCompletePRCheckOwner(pr)
  if ((!complete && checksError !== null) || (complete && !pr.checksSummary)) {
    return {
      ...base,
      tone: 'idle',
      title: t('pullRequest.gates.checksUnavailable', 'Checks unavailable'),
      subtitle: checksError
    }
  }
  const ownerSummary = complete ? pr.checksSummary : undefined
  const broken = checks.filter((check) => checkOutcome(check) === 'failure')
  const brokenCount = ownerSummary
    ? ownerSummary.failed - (ownerSummary.cancelled ?? 0)
    : broken.length
  if (brokenCount > 0) {
    return {
      ...base,
      tone: 'blocking',
      title:
        brokenCount === 1
          ? t('pullRequest.gates.checksFailing_one', '{{count}} check failing', {
              count: brokenCount
            })
          : t('pullRequest.gates.checksFailing_other', '{{count}} checks failing', {
              count: brokenCount
            }),
      subtitle: broken.length > 0 ? broken.map((check) => check.name).join(', ') : null
    }
  }
  const rowSummary = summarizePRChecks(checks, t)
  const summary = ownerSummary
    ? { ...ownerSummary, outcome: getProviderChecksOutcome(ownerSummary), label: rowSummary.label }
    : rowSummary
  if (summary.pending > 0) {
    return {
      ...base,
      tone: 'waiting',
      title:
        summary.pending === 1
          ? t('pullRequest.gates.checksRunning_one', '{{count}} check running', {
              count: summary.pending
            })
          : t('pullRequest.gates.checksRunning_other', '{{count}} checks running', {
              count: summary.pending
            }),
      subtitle:
        summary.passed > 0
          ? t('pullRequest.gates.checksPassedSoFar', '{{count}} passed so far', {
              count: summary.passed
            })
          : null
    }
  }
  if (summary.outcome === 'cancelled') {
    return {
      ...base,
      tone: 'idle',
      title: t('pullRequest.checkStatus.cancelled', 'Cancelled'),
      subtitle: checks.length > 0 ? rowSummary.label : null
    }
  }
  if (summary.total === 0) {
    return {
      ...base,
      tone: 'idle',
      title: t('pullRequest.gates.noChecks', 'No checks'),
      subtitle: null
    }
  }
  // Neutral checks did not pass, so they neither count as passed nor turn the row green on their own.
  const other = summary.total - summary.passed
  return {
    ...base,
    tone: summary.passed > 0 ? 'passed' : 'idle',
    title:
      summary.passed === 0
        ? t('pullRequest.gates.checksFinished', 'Checks finished')
        : summary.passed === 1
          ? t('pullRequest.gates.checksPassed_one', '{{count}} check passed', {
              count: summary.passed
            })
          : t('pullRequest.gates.checksPassed_other', '{{count}} checks passed', {
              count: summary.passed
            }),
    subtitle:
      other > 0 ? t('pullRequest.gates.checksNeutral', '{{count}} neutral', { count: other }) : null
  }
}

function threadsGate(
  details: GitHubWorkItemDetails | null,
  detailsLoading: boolean,
  t: Translate,
  botAuthorOverrides?: ReadonlySet<string>
): PrGateRow {
  const base = { key: 'threads', target: 'comments' } as const
  if (!details) {
    return {
      ...base,
      tone: detailsLoading ? 'loading' : 'idle',
      title: t('pullRequest.gates.threads', 'Review threads'),
      subtitle: detailsLoading
        ? null
        : t('pullRequest.gates.commentsUnavailable', 'Comments unavailable')
    }
  }
  const threads = groupPRComments(details.comments).filter((group) => group.kind === 'thread')
  const unresolved = threads.filter((group) => group.root.isResolved !== true)
  if (unresolved.length === 0) {
    return {
      ...base,
      tone: threads.length > 0 ? 'passed' : 'idle',
      title:
        threads.length > 0
          ? t('pullRequest.gates.allThreadsResolved', 'All threads resolved')
          : t('pullRequest.gates.noThreads', 'No review threads'),
      subtitle: null
    }
  }
  const first = unresolved[0].root
  const fileName = first.path?.split('/').pop()
  const bots = unresolved.filter((group) => isBotPRComment(group.root, botAuthorOverrides)).length
  const parts = [
    fileName
      ? t('pullRequest.gates.threadAuthorOnFile', '{{author}} on {{file}}', {
          author: first.author,
          file: fileName
        })
      : first.author
  ]
  if (bots > 0) {
    parts.push(
      bots === 1
        ? t('pullRequest.gates.fromBots_one', '{{count}} from a bot', { count: bots })
        : t('pullRequest.gates.fromBots_other', '{{count}} from bots', { count: bots })
    )
  }
  return {
    ...base,
    tone: 'waiting',
    title:
      unresolved.length === 1
        ? t('pullRequest.gates.unresolvedThreads_one', '{{count}} unresolved thread', {
            count: unresolved.length
          })
        : t('pullRequest.gates.unresolvedThreads_other', '{{count}} unresolved threads', {
            count: unresolved.length
          }),
    subtitle: parts.join(' · ')
  }
}

// GitHub does not report the required approval count, so the row counts approvals and lets reviewDecision decide the tone.
function approvalsGate(
  pr: PRInfo,
  details: GitHubWorkItemDetails | null,
  detailsLoading: boolean,
  t: Translate
): PrGateRow {
  const base = { key: 'approvals', target: 'reviewers' } as const
  const decision = details?.item.reviewDecision ?? pr.reviewDecision ?? null
  const reviews = details?.item.latestReviews ?? []
  const approved = reviews.filter((review) => review.state === 'APPROVED').map((r) => r.login)
  const changesRequested = reviews
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .map((r) => r.login)
  const requested = (details?.item.reviewRequests ?? []).map((user) => user.login)

  if (decision === 'CHANGES_REQUESTED' || changesRequested.length > 0) {
    return {
      ...base,
      tone: 'blocking',
      title: t('pullRequest.gates.changesRequested', 'Changes requested'),
      subtitle:
        changesRequested.length > 0
          ? t('pullRequest.gates.requestedChangesBy', '{{logins}} requested changes', {
              logins: changesRequested.join(', ')
            })
          : null
    }
  }
  const parts: string[] = []
  if (approved.length > 0) {
    parts.push(
      t('pullRequest.gates.approvedBy', '{{logins}} approved', {
        logins: approved.join(', ')
      })
    )
  }
  if (requested.length > 0) {
    parts.push(
      t('pullRequest.gates.reviewRequestedFrom', '{{logins}} requested', {
        logins: requested.join(', ')
      })
    )
  } else if (decision === 'REVIEW_REQUIRED') {
    parts.push(t('pullRequest.gates.reviewRequired', 'Review required'))
  }
  const title =
    approved.length === 0
      ? t('pullRequest.gates.noApprovals', 'No approvals yet')
      : approved.length === 1
        ? t('pullRequest.gates.approvals_one', '{{count}} approval', { count: approved.length })
        : t('pullRequest.gates.approvals_other', '{{count}} approvals', { count: approved.length })
  const tone: PrGateTone =
    !details && detailsLoading
      ? 'loading'
      : decision === 'REVIEW_REQUIRED' || requested.length > 0
        ? 'waiting'
        : approved.length > 0 || decision === 'APPROVED'
          ? 'passed'
          : 'idle'
  return { ...base, tone, title, subtitle: parts.length > 0 ? parts.join(' · ') : null }
}

function conflictsGate(pr: PRInfo, detailsBaseRef: string | null, t: Translate): PrGateRow {
  const base = { key: 'conflicts', target: null } as const
  const baseRef = pr.conflictSummary?.baseRef ?? pr.baseRefName ?? detailsBaseRef
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    const files = pr.conflictSummary?.files.length ?? 0
    return {
      ...base,
      tone: 'blocking',
      title: baseRef
        ? t('pullRequest.gates.conflictsWithBase', 'Conflicts with {{base}}', {
            base: baseRef
          })
        : t('pullRequest.gates.conflicts', 'Merge conflicts'),
      subtitle:
        files === 0
          ? null
          : files === 1
            ? t('pullRequest.gates.conflictFiles_one', '{{count}} file', { count: files })
            : t('pullRequest.gates.conflictFiles_other', '{{count}} files', { count: files })
    }
  }
  // Green only on GitHub's word: UNKNOWN or missing metadata means it is still computing.
  const confirmedClean =
    pr.mergeable === 'MERGEABLE' ||
    ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BLOCKED', 'BEHIND'].includes(pr.mergeStateStatus ?? '')
  if (!confirmedClean) {
    return {
      ...base,
      tone: 'idle',
      title: t('pullRequest.gates.conflictsChecking', 'Checking for conflicts'),
      subtitle: null
    }
  }
  return {
    ...base,
    tone: 'passed',
    title: baseRef
      ? t('pullRequest.gates.noConflictsWithBase', 'No conflicts with {{base}}', {
          base: baseRef
        })
      : t('pullRequest.gates.noConflicts', 'No conflicts'),
    subtitle: null
  }
}
