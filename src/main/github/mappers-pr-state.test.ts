import { describe, expect, it } from 'vitest'
import { mapPRState } from './mappers'
import {
  isQueuedPullRequest,
  toPullRequestWireState,
  withDerivedPullRequestQueueState
} from '../../shared/github/pull-request-queue-state'

const entry = { state: 'QUEUED', position: 3 }

describe('mapPRState', () => {
  it('never derives queued — that value is client-side only', () => {
    expect(mapPRState('OPEN', false)).toBe('open')
    expect(mapPRState('open')).toBe('open')
  })

  it('maps merged, closed, and draft as before', () => {
    expect(mapPRState('MERGED', false)).toBe('merged')
    expect(mapPRState('CLOSED', false)).toBe('closed')
    expect(mapPRState('OPEN', true)).toBe('draft')
  })
})

describe('client-side queued derivation', () => {
  it('derives queued only for an open PR carrying a queue entry', () => {
    expect(withDerivedPullRequestQueueState({ state: 'open', mergeQueueEntry: entry })).toEqual({
      state: 'queued',
      mergeQueueEntry: entry
    })
    expect(withDerivedPullRequestQueueState({ state: 'open' })).toEqual({ state: 'open' })
  })

  it('lets merged, closed, and draft win over a stale queue entry', () => {
    for (const state of ['merged', 'closed', 'draft'] as const) {
      expect(withDerivedPullRequestQueueState({ state, mergeQueueEntry: entry })).toEqual({
        state,
        mergeQueueEntry: entry
      })
      expect(isQueuedPullRequest({ state, mergeQueueEntry: entry })).toBe(false)
    }
  })

  it('narrows queued back to open for the wire', () => {
    expect(toPullRequestWireState('queued')).toBe('open')
    expect(toPullRequestWireState('draft')).toBe('draft')
  })
})
