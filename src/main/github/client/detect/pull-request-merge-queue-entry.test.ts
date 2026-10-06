import { describe, expect, it } from 'vitest'
import { parsePullRequestMergeQueueEntryResponse } from './pull-request-merge-queue-entry'

const respond = (pullRequest: unknown): string =>
  JSON.stringify({ data: { repository: { pullRequest } } })

describe('parsePullRequestMergeQueueEntryResponse', () => {
  it('reads the queue position and state of a queued PR', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        respond({ isInMergeQueue: true, mergeQueueEntry: { position: 3, state: 'AWAITING_CHECKS' } })
      )
    ).toEqual({ position: 3, state: 'AWAITING_CHECKS' })
  })

  it('reports a PR outside the queue as null', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        respond({ isInMergeQueue: false, mergeQueueEntry: null })
      )
    ).toBeNull()
  })

  it('keeps a queued PR whose entry GitHub did not return', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(respond({ isInMergeQueue: true, mergeQueueEntry: null }))
    ).toEqual({ position: null, state: null })
  })

  it('treats an unknown state as no state', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        respond({ isInMergeQueue: true, mergeQueueEntry: { position: 1, state: 'FUTURE_STATE' } })
      )
    ).toEqual({ position: 1, state: null })
  })

  it('returns undefined when GitHub sends an error payload', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(JSON.stringify({ errors: [{ message: 'boom' }] }))
    ).toBeUndefined()
  })
})
