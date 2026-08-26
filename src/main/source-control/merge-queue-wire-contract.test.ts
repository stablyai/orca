import { describe, expect, it } from 'vitest'
import { mapGitHubReview } from './forge-review-mappers'
import { assemblePRRefreshFoundOutcome } from '../github/client/lookup/pr-refresh-outcome-assembly'
import { mapPullRequestWorkItem } from '../github/client/map/work-item'
import type { MainWorkItem } from '../github/client/map/work-item-field-coercion'
import type { HostedReviewWireInfo } from '../../shared/hosted-review'
import type { PRInfo, PRWireState } from '../../shared/github/pull-request-types'
import {
  isQueuedPullRequest,
  withDerivedPRInfoQueueState,
  withDerivedPullRequestQueueState
} from '../../shared/github/pull-request-queue-state'

// Why: a host publishing `queued` would be silently dropped or mis-branched by an
// older client. These assertions fail at compile time if the wire types ever widen.
type HasNoQueued<T> = [Extract<T, 'queued'>] extends [never] ? true : false
const WIRE_TYPES_EXCLUDE_QUEUED: [
  HasNoQueued<PRWireState>,
  HasNoQueued<HostedReviewWireInfo['state']>,
  HasNoQueued<MainWorkItem['state']>
] = [true, true, true]

const mergeQueueEntry = { state: 'QUEUED', position: 2, estimatedTimeToMerge: 600 }

function queuedPRInfo(): PRInfo {
  return {
    number: 7,
    title: 'A pull request',
    // Why: only a client ever holds this value; construct it here to prove the
    // publish boundary narrows it rather than forwarding it.
    state: 'queued',
    url: 'https://github.com/stablyai/orca/pull/7',
    checksStatus: 'success',
    updatedAt: '2026-08-26T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeQueueEntry
  }
}

describe('merge-queue wire contract', () => {
  it('excludes queued from every published state type', () => {
    expect(WIRE_TYPES_EXCLUDE_QUEUED).toEqual([true, true, true])
  })

  it('publishes a queued review as open, carrying the queue entry', () => {
    const wire = mapGitHubReview(queuedPRInfo())
    expect(wire.state).toBe('open')
    expect(wire.mergeQueueEntry).toEqual(mergeQueueEntry)
  })

  it('never assembles a queued PR state from a lookup carrying a queue entry', () => {
    const outcome = assemblePRRefreshFoundOutcome({
      data: {
        number: 7,
        title: 'A pull request',
        state: 'OPEN',
        url: 'https://github.com/stablyai/orca/pull/7',
        statusCheckRollup: [],
        updatedAt: '2026-08-26T00:00:00Z',
        mergeable: 'MERGEABLE',
        mergeQueueEntry
      },
      dataRepo: null,
      dataHeadRepo: null,
      stack: undefined,
      mergeable: 'MERGEABLE',
      stackMergeQueueRequired: undefined,
      confirmedContainedHeadOid: null,
      headDivergedFromMergedPRAtOid: null,
      conflictSummary: undefined
    })
    expect(outcome.kind).toBe('found')
    if (outcome.kind !== 'found') {
      return
    }
    expect(outcome.pr.state).toBe('open')
    expect(outcome.pr.mergeQueueEntry).toEqual(mergeQueueEntry)
    // Why: the wire value is what an old client renders; a new client re-derives.
    expect(isQueuedPullRequest(outcome.pr)).toBe(true)
    expect(withDerivedPRInfoQueueState(outcome.pr)?.state).toBe('queued')
  })

  it('publishes a queued work item as open, carrying the queue entry', () => {
    const mapped: MainWorkItem = {
      ...mapPullRequestWorkItem({ number: 7, title: 'A pull request', state: 'OPEN' }),
      mergeQueueEntry
    }
    expect(mapped.state).toBe('open')
    // Why: the client re-derives; the host never publishes the refinement itself.
    expect(isQueuedPullRequest(mapped)).toBe(true)
    expect(withDerivedPullRequestQueueState(mapped)?.state).toBe('queued')
  })

  it('round-trips a client-derived queued state back to the wire value', () => {
    const derived = withDerivedPRInfoQueueState({ ...queuedPRInfo(), state: 'open' })
    expect(derived?.state).toBe('queued')
    expect(mapGitHubReview(derived!).state).toBe('open')
  })
})
