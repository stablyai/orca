import { describe, expect, it } from 'vitest'
import { nextBranchCompareState } from './mobile-branch-compare-outcome'
import type { BranchCompareOutcome } from './mobile-branch-compare-outcome'
import type { MobileGitBranchCompareReply } from './git-compare-reply-schema'
import type { MobileBranchCompareState } from './mobile-source-control-screen-state'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapping passes the reply through untouched and reads no member of it.
const REPLY = { summary: { baseRef: 'origin/main' } } as MobileGitBranchCompareReply

const READY: MobileBranchCompareState = { kind: 'ready', result: REPLY }
const UNAVAILABLE: BranchCompareOutcome = { kind: 'unavailable' }
const FAILED: BranchCompareOutcome = { kind: 'failed', message: 'no base' }

describe('nextBranchCompareState', () => {
  it('publishes a ready compare whatever the previous state was', () => {
    const outcome: BranchCompareOutcome = { kind: 'ready', result: REPLY }
    expect(nextBranchCompareState(outcome, { kind: 'idle' })).toEqual(READY)
    expect(nextBranchCompareState(outcome, { kind: 'error', message: 'old' })).toEqual(READY)
  })

  it('keeps a prior ready compare when a re-read fails', () => {
    expect(nextBranchCompareState(FAILED, READY)).toBe(READY)
    expect(nextBranchCompareState(UNAVAILABLE, READY)).toBe(READY)
  })

  it('separates a host without git from an attempt that failed', () => {
    expect(nextBranchCompareState(UNAVAILABLE, { kind: 'loading' })).toEqual({
      kind: 'idle'
    })
    expect(nextBranchCompareState(FAILED, { kind: 'loading' })).toEqual({
      kind: 'error',
      message: 'no base'
    })
  })
})
