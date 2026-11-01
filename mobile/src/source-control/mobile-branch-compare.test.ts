import { describe, expect, it } from 'vitest'
import {
  buildMobileBranchCompareSection,
  canOpenMobileBranchCompareDiff
} from './mobile-branch-compare'

describe('mobile branch compare helpers', () => {
  it('sorts committed branch entries by path', () => {
    const section = buildMobileBranchCompareSection([
      { path: 'zeta.ts', status: 'modified' },
      { path: 'alpha.ts', status: 'added' }
    ])

    expect(section?.title).toBe('Committed on Branch')
    expect(section?.data.map((entry) => entry.path)).toEqual(['alpha.ts', 'zeta.ts'])
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
        commitsAhead: undefined,
        errorMessage: undefined,
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
        commitsAhead: undefined,
        errorMessage: undefined,
        status: 'unborn-head'
      })
    ).toBe(false)
  })
})
