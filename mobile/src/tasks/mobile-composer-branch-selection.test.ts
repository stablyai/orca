import { describe, expect, it } from 'vitest'
import { resolveComposerBranchSelection } from './mobile-composer-branch-selection'

describe('resolveComposerBranchSelection', () => {
  it('preserves a manual Tasks workspace name that prefixes the selected branch', () => {
    expect(
      resolveComposerBranchSelection({
        refName: 'feature/mobile',
        localBranchName: 'feature/mobile',
        currentName: 'feat',
        lastAutoName: ''
      })
    ).toEqual({
      baseBranch: 'feature/mobile',
      branchNameOverride: undefined,
      branchAutoName: '',
      name: undefined,
      lastAutoName: undefined
    })
  })
})
