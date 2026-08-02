import { describe, expect, it } from 'vitest'
import {
  isMobileConflictAborting,
  mobileConflictAbortLabel
} from './mobile-source-control-conflict-abort'

describe('isMobileConflictAborting', () => {
  it('is true only for the matching abort action', () => {
    expect(isMobileConflictAborting('abort-merge', 'merge')).toBe(true)
    expect(isMobileConflictAborting('abort-rebase', 'rebase')).toBe(true)
  })

  it('is false for other busy actions (stage/commit must not look like abort)', () => {
    expect(isMobileConflictAborting('stage-all', 'merge')).toBe(false)
    expect(isMobileConflictAborting('commit', 'rebase')).toBe(false)
    expect(isMobileConflictAborting(null, 'merge')).toBe(false)
    expect(isMobileConflictAborting('abort-merge', 'rebase')).toBe(false)
    expect(isMobileConflictAborting('abort-merge', 'unknown')).toBe(false)
  })
})

describe('mobileConflictAbortLabel', () => {
  it('shows Aborting only while abort is in flight', () => {
    expect(mobileConflictAbortLabel('merge', true)).toBe('Aborting…')
    expect(mobileConflictAbortLabel('merge', false)).toBe('Abort merge')
    expect(mobileConflictAbortLabel('rebase', false)).toBe('Abort rebase')
  })
})
