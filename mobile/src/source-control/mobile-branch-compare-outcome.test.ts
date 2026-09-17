import { describe, expect, it } from 'vitest'
import { nextBranchCompareState } from './mobile-branch-compare-outcome'
import type { BranchCompareOutcome } from './mobile-branch-compare-outcome'
import type { MobileGitBranchCompareReply } from './git-compare-reply-schema'
import type { MobileBranchCompareState } from './mobile-source-control-screen-state'

// The screen mapping on its own. Which attempt reaches it is the owner's question, pinned by the
// schedules in use-mobile-source-control-loaders.test.ts; this is only what each ending renders.

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapping passes the reply through untouched and reads no member of it.
const REPLY = { summary: { baseRef: 'origin/main' } } as MobileGitBranchCompareReply

const READY: MobileBranchCompareState = { kind: 'ready', result: REPLY }
const UNAVAILABLE: BranchCompareOutcome = { kind: 'unavailable' }
const FAILED: BranchCompareOutcome = { kind: 'failed', message: 'no base' }

describe('nextBranchCompareState', () => {
  it('publishes a ready compare whatever the previous state was', () => {
    const outcome: BranchCompareOutcome = { kind: 'ready', result: REPLY }
    expect(nextBranchCompareState(outcome, { kind: 'idle' }, false)).toEqual(READY)
    expect(nextBranchCompareState(outcome, { kind: 'error', message: 'old' }, true)).toEqual(READY)
  })

  it('keeps a prior ready compare only when the caller asked for it', () => {
    expect(nextBranchCompareState(FAILED, READY, true)).toBe(READY)
    expect(nextBranchCompareState(UNAVAILABLE, READY, true)).toBe(READY)
    expect(nextBranchCompareState(FAILED, READY, false)).toEqual({
      kind: 'error',
      message: 'no base'
    })
  })

  it('separates a host without git from an attempt that failed', () => {
    expect(nextBranchCompareState(UNAVAILABLE, { kind: 'loading' }, false)).toEqual({
      kind: 'idle'
    })
    expect(nextBranchCompareState(FAILED, { kind: 'loading' }, false)).toEqual({
      kind: 'error',
      message: 'no base'
    })
  })
})
