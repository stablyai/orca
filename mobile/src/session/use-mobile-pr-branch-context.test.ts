import { describe, expect, it } from 'vitest'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import { deriveMobilePrBranchContext } from './use-mobile-pr-branch-context'

function status(overrides: Partial<MobileGitStatusResult>): MobileGitStatusResult {
  return {
    entries: [],
    conflictOperation: 'unknown',
    branch: undefined,
    head: undefined,
    ...overrides
  }
}

function branchCompare(headOid: string | null): MobileGitBranchCompareResult {
  return {
    summary: {
      baseRef: 'main',
      baseOid: null,
      compareRef: 'feature',
      headOid,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: undefined,
      status: 'ready',
      errorMessage: undefined
    },
    entries: []
  }
}

describe('deriveMobilePrBranchContext', () => {
  it('uses status.head when present', () => {
    const result = deriveMobilePrBranchContext(
      status({ branch: 'feature', head: 'sha-status' }),
      branchCompare('sha-compare')
    )
    expect(result.headSha).toBe('sha-status')
    expect(result.branch).toBe('feature')
  })

  it('falls back to branchCompare headOid when status.head is absent', () => {
    const result = deriveMobilePrBranchContext(
      status({ branch: 'feature', head: undefined }),
      branchCompare('sha-compare')
    )
    expect(result.headSha).toBe('sha-compare')
  })

  it('returns null headSha when both status.head and headOid are absent', () => {
    const result = deriveMobilePrBranchContext(
      status({ branch: 'feature', head: undefined }),
      branchCompare(null)
    )
    expect(result.headSha).toBeNull()
  })

  it('returns null headSha when branchCompare is missing entirely', () => {
    const result = deriveMobilePrBranchContext(status({ branch: 'feature' }), null)
    expect(result.headSha).toBeNull()
  })

  it('derives branch from status.branch', () => {
    const result = deriveMobilePrBranchContext(status({ branch: 'topic' }), null)
    expect(result.branch).toBe('topic')
  })

  it('returns null branch when status.branch is absent', () => {
    const result = deriveMobilePrBranchContext(status({ branch: undefined }), null)
    expect(result.branch).toBeNull()
  })

  it('does not throw on null status and null branchCompare', () => {
    expect(() => deriveMobilePrBranchContext(null, null)).not.toThrow()
    const result = deriveMobilePrBranchContext(null, null)
    expect(result).toEqual({ branch: null, headSha: null })
  })
})
