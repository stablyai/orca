import { describe, expect, expectTypeOf, it } from 'vitest'
import type { GitBranchCompareResult } from '../../../src/shared/types'
import {
  buildMobileBranchCompareSection,
  canOpenMobileBranchCompareDiff,
  formatMobileBranchCompareSummary,
  type MobileGitBranchCompareResult
} from './mobile-branch-compare'

describe('mobile branch compare helpers', () => {
  it('keeps the mobile branch compare type in lockstep with the runtime contract', () => {
    expectTypeOf<MobileGitBranchCompareResult>().toEqualTypeOf<GitBranchCompareResult>()
  })

  it('sorts committed branch entries by path', () => {
    const section = buildMobileBranchCompareSection([
      { path: 'zeta.ts', status: 'modified' },
      { path: 'alpha.ts', status: 'added' }
    ])

    expect(section?.title).toBe('Committed on Branch')
    expect(section?.data.map((entry) => entry.path)).toEqual(['alpha.ts', 'zeta.ts'])
  })

  it('summarizes ready branch compares', () => {
    expect(
      formatMobileBranchCompareSummary({
        baseRef: 'origin/main',
        baseOid: 'a'.repeat(40),
        compareRef: 'HEAD',
        headOid: 'b'.repeat(40),
        mergeBase: 'c'.repeat(40),
        changedFiles: 2,
        commitsAhead: 1,
        status: 'ready'
      })
    ).toBe('2 files - 1 commit - vs origin/main')
  })

  it('only opens branch diffs when compare object ids are available', () => {
    expect(
      canOpenMobileBranchCompareDiff({
        baseRef: 'origin/main',
        baseOid: 'a'.repeat(40),
        compareRef: 'HEAD',
        headOid: 'b'.repeat(40),
        mergeBase: 'c'.repeat(40),
        changedFiles: 1,
        status: 'ready'
      })
    ).toBe(true)

    expect(
      canOpenMobileBranchCompareDiff({
        baseRef: 'origin/main',
        baseOid: null,
        compareRef: 'HEAD',
        headOid: null,
        mergeBase: null,
        changedFiles: 0,
        status: 'unborn-head'
      })
    ).toBe(false)
  })
})
