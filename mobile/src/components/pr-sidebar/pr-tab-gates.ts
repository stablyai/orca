import type { PRCheckDetail } from '../../../../src/shared/github/check-types'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import { groupPRComments } from '../../../../src/shared/pr-comment-groups'
import { isBotPRComment } from '../../../../src/shared/pr-comment-audience'
import { translate } from '../../i18n/mobile-i18n'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import { checkOutcome, summarizePRChecks } from './pr-checks-presentation'

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

export function buildPrGateRows(input: GateInput): PrGateRow[] {
  const details =
    input.details && !isPrSidebarDetailsPlaceholder(input.details) ? input.details : null
  // Null details means still loading; a placeholder means the read failed.
  const detailsLoading = input.details === null
  return [
    checksGate(input.checks, input.checksError),
    threadsGate(details, detailsLoading, input.botAuthorOverrides),
    approvalsGate(input.pr, details, detailsLoading),
    conflictsGate(input.pr, details?.item.baseRefName ?? null)
  ]
}

function checksGate(checks: PRCheckDetail[], checksError: string | null): PrGateRow {
  const base = { key: 'checks', target: 'checks' } as const
  if (checksError !== null) {
    return {
      ...base,
      tone: 'idle',
      title: translate('pullRequest.gates.checksUnavailable', 'Checks unavailable'),
      subtitle: checksError
    }
  }
  const broken = checks.filter((check) => checkOutcome(check) === 'failure')
  if (broken.length > 0) {
    return {
      ...base,
      tone: 'blocking',
      title:
        broken.length === 1
          ? translate('pullRequest.gates.checksFailing_one', '{{count}} check failing', {
              count: broken.length
            })
          : translate('pullRequest.gates.checksFailing_other', '{{count}} checks failing', {
              count: broken.length
            }),
      subtitle: broken.map((check) => check.name).join(', ')
    }
  }
  const summary = summarizePRChecks(checks)
  if (summary.pending > 0) {
    return {
      ...base,
      tone: 'waiting',
      title:
        summary.pending === 1
          ? translate('pullRequest.gates.checksRunning_one', '{{count}} check running', {
              count: summary.pending
            })
          : translate('pullRequest.gates.checksRunning_other', '{{count}} checks running', {
              count: summary.pending
            }),
      subtitle:
        summary.passed > 0
          ? translate('pullRequest.gates.checksPassedSoFar', '{{count}} passed so far', {
              count: summary.passed
            })
          : null
    }
  }
  if (summary.total === 0) {
    return {
      ...base,
      tone: 'idle',
      title: translate('pullRequest.gates.noChecks', 'No checks'),
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
        ? translate('pullRequest.gates.checksFinished', 'Checks finished')
        : summary.passed === 1
          ? translate('pullRequest.gates.checksPassed_one', '{{count}} check passed', {
              count: summary.passed
            })
          : translate('pullRequest.gates.checksPassed_other', '{{count}} checks passed', {
              count: summary.passed
            }),
    subtitle:
      other > 0
        ? translate('pullRequest.gates.checksNeutral', '{{count}} neutral', {
            count: other
          })
        : null
  }
}

function threadsGate(
  details: GitHubWorkItemDetails | null,
  detailsLoading: boolean,
  botAuthorOverrides?: ReadonlySet<string>
): PrGateRow {
  const base = { key: 'threads', target: 'comments' } as const
  if (!details) {
    return {
      ...base,
      tone: detailsLoading ? 'loading' : 'idle',
      title: translate('pullRequest.gates.threads', 'Review threads'),
      subtitle: detailsLoading
        ? null
        : translate('pullRequest.gates.commentsUnavailable', 'Comments unavailable')
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
          ? translate('pullRequest.gates.allThreadsResolved', 'All threads resolved')
          : translate('pullRequest.gates.noThreads', 'No review threads'),
      subtitle: null
    }
  }
  const first = unresolved[0].root
  const fileName = first.path?.split('/').pop()
  const bots = unresolved.filter((group) => isBotPRComment(group.root, botAuthorOverrides)).length
  const parts = [
    fileName
      ? translate('pullRequest.gates.threadAuthorOnFile', '{{author}} on {{file}}', {
          author: first.author,
          file: fileName
        })
      : first.author
  ]
  if (bots > 0) {
    parts.push(
      bots === 1
        ? translate('pullRequest.gates.fromBots_one', '{{count}} from a bot', { count: bots })
        : translate('pullRequest.gates.fromBots_other', '{{count}} from bots', { count: bots })
    )
  }
  return {
    ...base,
    tone: 'waiting',
    title:
      unresolved.length === 1
        ? translate('pullRequest.gates.unresolvedThreads_one', '{{count}} unresolved thread', {
            count: unresolved.length
          })
        : translate('pullRequest.gates.unresolvedThreads_other', '{{count}} unresolved threads', {
            count: unresolved.length
          }),
    subtitle: parts.join(' · ')
  }
}

// GitHub does not report the required approval count, so the row counts approvals and lets reviewDecision decide the tone.
function approvalsGate(
  pr: PRInfo,
  details: GitHubWorkItemDetails | null,
  detailsLoading: boolean
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
      title: translate('pullRequest.gates.changesRequested', 'Changes requested'),
      subtitle:
        changesRequested.length > 0
          ? translate('pullRequest.gates.requestedChangesBy', '{{logins}} requested changes', {
              logins: changesRequested.join(', ')
            })
          : null
    }
  }
  const parts: string[] = []
  if (approved.length > 0) {
    parts.push(
      translate('pullRequest.gates.approvedBy', '{{logins}} approved', {
        logins: approved.join(', ')
      })
    )
  }
  if (requested.length > 0) {
    parts.push(
      translate('pullRequest.gates.reviewRequestedFrom', '{{logins}} requested', {
        logins: requested.join(', ')
      })
    )
  } else if (decision === 'REVIEW_REQUIRED') {
    parts.push(translate('pullRequest.gates.reviewRequired', 'Review required'))
  }
  const title =
    approved.length === 0
      ? translate('pullRequest.gates.noApprovals', 'No approvals yet')
      : approved.length === 1
        ? translate('pullRequest.gates.approvals_one', '{{count}} approval', {
            count: approved.length
          })
        : translate('pullRequest.gates.approvals_other', '{{count}} approvals', {
            count: approved.length
          })
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

function conflictsGate(pr: PRInfo, detailsBaseRef: string | null): PrGateRow {
  const base = { key: 'conflicts', target: null } as const
  const baseRef = pr.conflictSummary?.baseRef ?? pr.baseRefName ?? detailsBaseRef
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    const files = pr.conflictSummary?.files.length ?? 0
    return {
      ...base,
      tone: 'blocking',
      title: baseRef
        ? translate('pullRequest.gates.conflictsWithBase', 'Conflicts with {{base}}', {
            base: baseRef
          })
        : translate('pullRequest.gates.conflicts', 'Merge conflicts'),
      subtitle:
        files === 0
          ? null
          : files === 1
            ? translate('pullRequest.gates.conflictFiles_one', '{{count}} file', { count: files })
            : translate('pullRequest.gates.conflictFiles_other', '{{count}} files', {
                count: files
              })
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
      title: translate('pullRequest.gates.conflictsChecking', 'Checking for conflicts'),
      subtitle: null
    }
  }
  return {
    ...base,
    tone: 'passed',
    title: baseRef
      ? translate('pullRequest.gates.noConflictsWithBase', 'No conflicts with {{base}}', {
          base: baseRef
        })
      : translate('pullRequest.gates.noConflicts', 'No conflicts'),
    subtitle: null
  }
}
