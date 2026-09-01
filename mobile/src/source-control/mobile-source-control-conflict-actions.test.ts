import { describe, expect, it } from 'vitest'
import {
  isMobileConflictAborting,
  isMobileConflictAdvancing,
  mobileConflictAbortLabel,
  mobileConflictContinueLabel
} from './mobile-source-control-conflict-actions'

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

describe('isMobileConflictAdvancing', () => {
  it('is true only for the matching continue action', () => {
    expect(isMobileConflictAdvancing('continue-merge', 'merge')).toBe(true)
    expect(isMobileConflictAdvancing('continue-rebase', 'rebase')).toBe(true)
    expect(isMobileConflictAdvancing('continue-cherry-pick', 'cherry-pick')).toBe(true)
  })

  it('is false for other busy actions (abort/stage must not look like continue)', () => {
    expect(isMobileConflictAdvancing('abort-merge', 'merge')).toBe(false)
    expect(isMobileConflictAdvancing('stage-all', 'rebase')).toBe(false)
    expect(isMobileConflictAdvancing(null, 'cherry-pick')).toBe(false)
    expect(isMobileConflictAdvancing('continue-merge', 'rebase')).toBe(false)
    expect(isMobileConflictAdvancing('continue-merge', 'unknown')).toBe(false)
  })
})

describe('mobileConflictAbortLabel', () => {
  it('shows Aborting only while abort is in flight', () => {
    expect(mobileConflictAbortLabel('merge', true)).toBe('Aborting…')
    expect(mobileConflictAbortLabel('merge', false)).toBe('Abort merge')
    expect(mobileConflictAbortLabel('rebase', false)).toBe('Abort rebase')
  })
})

describe('mobileConflictContinueLabel', () => {
  it('shows Continuing only while continue is in flight', () => {
    expect(mobileConflictContinueLabel('rebase', true)).toBe('Continuing…')
    expect(mobileConflictContinueLabel('rebase', false)).toBe('Continue rebase')
    expect(mobileConflictContinueLabel('cherry-pick', false)).toBe('Continue cherry-pick')
  })
})
