import type { PRComment } from '../../../src/shared/types'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import {
  prStateBadge,
  type MobileStatusToken
} from '../components/pr-sidebar/pr-checks-presentation'
import { t } from '@/i18n/mobile-i18n'

// Pure derivation of the branch-card PR chip from the shared PR sidebar state.
// No React/native imports so the rollup precedence is unit-testable (KTD5). The
// chip and the Pull Request segment read the SAME PrSidebarState, so the chip's
// check rollup can never disagree with the checks list it links to.

// The single check-rollup token the chip shows. Exactly one wins, by precedence:
// merge conflict > failing > running > passed > no checks. Worst-actionable-first
// so a red/amber signal is never hidden behind a green count.
export type MobilePrChipRollup =
  | { kind: 'conflict'; text: string; token: MobileStatusToken }
  | { kind: 'failing'; text: string; token: MobileStatusToken }
  | { kind: 'running'; text: string; token: MobileStatusToken }
  | { kind: 'passed'; text: string; token: MobileStatusToken }
  | { kind: 'none'; text: string; token: MobileStatusToken }

export type MobilePrChipSummary =
  | { kind: 'loading' }
  // GitHub repo, but this branch has no open/linked PR — the chip becomes a
  // "create pull request" affordance that routes to the PR segment's composer.
  | { kind: 'none' }
  // A permanent (auth/permission) or transient failure loading PR data. The chip
  // degrades to a muted, tappable line rather than vanishing.
  | { kind: 'unavailable'; message: string }
  | {
      kind: 'ready'
      number: number
      stateLabel: string
      stateToken: MobileStatusToken
      rollup: MobilePrChipRollup
      // Unresolved review-comment count, when the deferred details payload has
      // loaded; null while it is still loading or unavailable.
      commentCount: number | null
    }

// Unresolved review threads (the "💬 n" count). Counts each inline thread once by
// threadId when it is not resolved; top-level conversation comments (no threadId)
// are not review threads and don't count. Returns null when details haven't loaded.
export function countUnresolvedReviewThreads(
  comments: PRComment[] | null | undefined
): number | null {
  if (!comments) {
    return null
  }
  const unresolved = new Set<string>()
  for (const comment of comments) {
    if (comment.threadId && comment.isResolved !== true) {
      unresolved.add(comment.threadId)
    }
  }
  return unresolved.size
}

export function buildMobilePrChipSummary(
  state: PrSidebarState,
  commentCount: number | null = null
): MobilePrChipSummary {
  switch (state.kind) {
    case 'hidden':
    case 'loading':
      return { kind: 'loading' }
    case 'none':
      return { kind: 'none' }
    case 'error':
    case 'blocked':
      return { kind: 'unavailable', message: state.message }
    case 'ready': {
      const badge = prStateBadge(state.data.pr.state)
      return {
        kind: 'ready',
        number: state.data.pr.number,
        stateLabel: badge.label,
        stateToken: badge.token,
        rollup: buildChipRollup(state),
        commentCount
      }
    }
  }
}

function buildChipRollup(state: Extract<PrSidebarState, { kind: 'ready' }>): MobilePrChipRollup {
  // Conflicts win: the checks may be green, but the PR still can't merge.
  if (state.data.pr.mergeable === 'CONFLICTING') {
    return { kind: 'conflict', text: t('task.conflicts'), token: 'statusAmber' }
  }
  // Shared classifier so the chip, the Checks list and the tasks grid never disagree about the same PR.
  const checks = summarizeProviderChecks(state.data.checks)
  if (checks.failed > 0) {
    return {
      kind: 'failing',
      text: t('mobilePrChipSummary.failing', {
        failingCheckCount: checks.failed
      }),
      token: 'statusRed'
    }
  }
  if (checks.pending > 0) {
    return {
      kind: 'running',
      text: t('pullRequest.checks.running', { count: checks.pending }),
      token: 'statusAmber'
    }
  }
  if (checks.passed > 0) {
    return { kind: 'passed', text: `${checks.passed}/${checks.total}`, token: 'statusGreen' }
  }
  // Checks that exist but resolved to nothing actionable are not "no checks".
  return {
    kind: 'none',
    text: checks.total === 0 ? t('mobilePrChipSummary.no') : t('mobilePrChipSummary.unresolved'),
    token: 'textSecondary'
  }
}
