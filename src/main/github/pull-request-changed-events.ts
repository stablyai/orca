import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { PRRefreshOutcomeObserver } from './pr-refresh-event-publisher'

export type PullRequestChange = Omit<
  Extract<RuntimeClientEvent, { type: 'pullRequestChanged' }>,
  'type'
>

// An evicted checkout costs one repeat event, so the bound only caps memory.
const MAX_TRACKED_CHECKOUTS = 256

// Errors say nothing about the PR, so they never publish.
function outcomeSignature(outcome: PRRefreshOutcome): string | null {
  if (outcome.kind === 'no-pr') {
    return 'no-pr'
  }
  if (outcome.kind !== 'found') {
    return null
  }
  const { number, state, headSha, updatedAt, checksStatus } = outcome.pr
  return JSON.stringify([number, state, headSha ?? null, updatedAt ?? null, checksStatus])
}

/**
 * Reports a checkout's PR only when a read finds it different from what was last reported: the
 * coordinator observes every refresh, including unchanged follow-ups, and each event costs a phone read.
 */
export function pullRequestChangeObserver(
  publish: (change: PullRequestChange) => void
): PRRefreshOutcomeObserver {
  const published = new Map<string, string>()
  const publishIfChanged = (change: PullRequestChange, signature: string): void => {
    const key = `${change.worktreeId}\0${change.branch}`
    if (published.get(key) === signature) {
      return
    }
    published.delete(key)
    published.set(key, signature)
    const oldest = published.keys().next().value
    if (published.size > MAX_TRACKED_CHECKOUTS && oldest !== undefined) {
      published.delete(oldest)
    }
    publish(change)
  }
  return (candidate, outcome, aliases) => {
    const signature = outcomeSignature(outcome)
    if (signature === null) {
      return
    }
    // One read can stand for several checkouts linked to the same PR. A client's own read names
    // no checkout, and that client already holds the answer.
    for (const { worktreeId, repoId, branch } of [candidate, ...aliases]) {
      if (worktreeId) {
        publishIfChanged({ worktreeId, repoId: repoId ?? candidate.repoId, branch }, signature)
      }
    }
  }
}
