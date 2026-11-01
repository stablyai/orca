import type { PRComment } from '../../../src/shared/github/comment-types'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import {
  prStateBadge,
  type MobileStatusToken
} from '../components/pr-sidebar/pr-checks-presentation'

// Use the sidebar’s same state so the chip and linked checks list cannot disagree.

export type MobilePrChipRollup =
  | { kind: 'conflict'; text: string; token: MobileStatusToken }
  | { kind: 'failing'; text: string; token: MobileStatusToken }
  | { kind: 'running'; text: string; token: MobileStatusToken }
  | { kind: 'passed'; text: string; token: MobileStatusToken }
  | { kind: 'none'; text: string; token: MobileStatusToken }

export type MobilePrChipSummary =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'unavailable'; message: string }
  | {
      kind: 'ready'
      number: number
      stateLabel: string
      stateToken: MobileStatusToken
      rollup: MobilePrChipRollup
      commentCount: number | null
    }

// Count unresolved inline threads once per threadId; conversation comments are not review threads.
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
  if (state.data.pr.mergeable === 'CONFLICTING') {
    return { kind: 'conflict', text: 'Conflicts', token: 'statusAmber' }
  }
  // Share classification with the checks list and tasks grid.
  const checks = summarizeProviderChecks(state.data.checks)
  if (checks.failed > 0) {
    return { kind: 'failing', text: `${checks.failed} failing`, token: 'statusRed' }
  }
  if (checks.pending > 0) {
    return { kind: 'running', text: `${checks.pending} running`, token: 'statusAmber' }
  }
  if (checks.passed > 0) {
    return { kind: 'passed', text: `${checks.passed}/${checks.total}`, token: 'statusGreen' }
  }
  // Existing checks with no actionable outcome are still distinct from no checks.
  return {
    kind: 'none',
    text: checks.total === 0 ? 'No checks' : 'Unresolved checks',
    token: 'textSecondary'
  }
}
