import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { CheckStatus } from '../../shared/github/pull-request-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { PRRefreshOutcomeObserver } from './pr-refresh-event-publisher'

export type PullRequestChange = Omit<
  Extract<RuntimeClientEvent, { type: 'pullRequestChanged' }>,
  'type'
>

type PublishedPR = { summary: string; checks: CheckStatus | null }

// An evicted checkout costs one repeat event, so the bound only caps memory.
const MAX_TRACKED_CHECKOUTS = 256

// Errors say nothing about the PR, so they never publish.
function observedPR(outcome: PRRefreshOutcome, last: PublishedPR | undefined): PublishedPR | null {
  if (outcome.kind === 'no-pr') {
    return { summary: 'no-pr', checks: null }
  }
  if (outcome.kind !== 'found') {
    return null
  }
  const { number, state, headSha, updatedAt, checksStatus, checksSummary } = outcome.pr
  return {
    summary: JSON.stringify([number, state, headSha ?? null, updatedAt ?? null]),
    // A read that couldn't load the checks (an error, or a watch read's page cap) reports 'neutral' without a summary.
    checks: checksSummary ? checksStatus : (last?.checks ?? null)
  }
}

/**
 * Reports a checkout's PR only when a read finds it different from what was last reported: the
 * coordinator observes every refresh, including unchanged follow-ups, and each event costs a phone read.
 */
export function pullRequestChangeObserver(
  publish: (change: PullRequestChange) => void
): PRRefreshOutcomeObserver {
  const published = new Map<string, PublishedPR>()
  const publishIfChanged = (change: PullRequestChange, outcome: PRRefreshOutcome): void => {
    const key = `${change.worktreeId}\0${change.branch}`
    const last = published.get(key)
    const next = observedPR(outcome, last)
    if (!next || (next.summary === last?.summary && next.checks === last.checks)) {
      return
    }
    published.delete(key)
    published.set(key, next)
    const oldest = published.keys().next().value
    if (published.size > MAX_TRACKED_CHECKOUTS && oldest !== undefined) {
      published.delete(oldest)
    }
    publish(change)
  }
  return (candidate, outcome, aliases) => {
    // One read can stand for several checkouts linked to the same PR. A client's own read names
    // no checkout, and that client already holds the answer.
    for (const { worktreeId, repoId, branch } of [candidate, ...aliases]) {
      if (worktreeId) {
        publishIfChanged({ worktreeId, repoId: repoId ?? candidate.repoId, branch }, outcome)
      }
    }
  }
}
